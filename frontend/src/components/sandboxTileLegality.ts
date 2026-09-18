// frontend/src/components/sandboxTileLegality.ts
//
// A LEGALITY FILTER FOR THE OFFLINE SANDBOX TILE PICKER, AND NOWHERE ELSE.
//
// Design note #0: this does not violate `TileSelectionPopup.tsx #4`'s "no client-side re-validation" policy,
// because that policy is about the CONTRACT-BACKED path and this module is not on it. On the sandbox path
// there is no chain, so nothing was ever asked and the local fallback returns all 46 tiles in all 6
// orientations with no legality claim of any kind. This is not a SECOND opinion competing with the contract's
// -- it is the ONLY opinion, and the alternative is not "defer to the contract", it is "offer the player a
// green double-city hub for a plain prairie hex". A filter that exists only where no authority is reachable
// cannot drift from an authority. The picker's provisional labelling STAYS ON.
//
// Design note #1: NO TILE IDs, AND NO HEX COORDINATES EITHER -- both would be a third source of truth for
// facts that already have two. Every decision is a function of METADATA, and the hex-side reads route through
// `archetypeForHex`, which resolves a hex STRUCTURALLY rather than by comparing names.
// Design note #2: two independent sources of centre counts agree, and the filter uses the better one -- the
// authored markers where they exist, the terrain tag otherwise. The harness re-checks that agreement rather
// than assuming it holds.
//
// Design notes #3/#4/#6/#7/#483: see `docs/ai_architecture/hex_tile_math.md`.

import { TILE_CATALOG_BY_ID, type TileColorTier, type TileCatalogEntry } from "./hexTileCatalog";
import {
  GRAY_HEXES,
  IMPASSABLE_BORDER_EDGES,
  LANDMARK_HEXES,
  LANDMARK_TRACKS,
  OFFBOARD_TRACKS,
  STATIC_BOARD_HEXES,
  TO_HEXES,
  YELLOW_OO_HEXES,
  boardMemo,
} from "./hexBoardData";
import { inTray, trayCountOf } from "./tileTray";
import {
  HEX_NEIGHBOR_OFFSETS,
  archetypeForHex,
  immutableHexRefusal,
  isBoardHex,
  liveEdges,
  liveEdgesForHex,
  rotateConnections,
} from "./hexGeometry";
import { TILE_GRAPHICS_CATALOG, tileArtworkEdgePairs } from "./TileGraphics";
import type { LegalTilePlacement, MapGridResponse } from "./hexContractTypes";
// Design note #483: the port key is `trackReach`'s to define. Importing it
// rather than re-templating `"q,r:edge"` here keeps one format -- a second
// hand-built copy is how a set lookup starts silently missing.
import { portKey } from "../gameEngine/trackReach";

/* ------------------------------------------------------------------ */
/* Revenue-centre counts                                              */
/* ------------------------------------------------------------------ */

export interface CentreCounts {
  cities: number;
  towns: number;
}

const NO_CENTRES: CentreCounts = { cities: 0, towns: 0 };

/** What each terrain tag implies -- design note #2's second source. `MountainRugged` is retained with zero
 *  centres because the Rust enum retains it (no tile carries it since Audit G-5/G-10); dropping it here would
 *  make this map non-total over `TerrainType`. */
const CENTRES_FOR_TERRAIN: Readonly<Record<string, CentreCounts>> = {
  Plain: { cities: 0, towns: 0 },
  MountainRugged: { cities: 0, towns: 0 },
  SmallTown: { cities: 0, towns: 1 },
  DoubleTown: { cities: 0, towns: 2 },
  MajorCityHub: { cities: 1, towns: 0 },
  DoubleCityHub: { cities: 2, towns: 0 },
  BostonHub: { cities: 1, towns: 0 },
  NewYorkHub: { cities: 2, towns: 0 },
};

/** Cities and towns printed on a tile -- design note #2. */
export function tileCentres(tileId: number): CentreCounts {
  const art = TILE_GRAPHICS_CATALOG[tileId];
  if (art) {
    let cities = 0;
    let towns = 0;
    for (const marker of art.markers) {
      if (marker.kind === "city") cities += 1;
      else towns += 1;
    }
    return { cities, towns };
  }
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  return (entry && CENTRES_FOR_TERRAIN[entry.terrain]) ?? NO_CENTRES;
}

/** Cities and towns printed on a HEX, in the same units. Read through `archetypeForHex`, so a laid tile's real
 *  terrain wins where one exists and the hex's own static designation answers otherwise. One classifier, shared
 *  with the renderer, rather than a second reading of the board tables. */
export function hexCentres(mapGrid: MapGridResponse, q: number, r: number): CentreCounts {
  switch (archetypeForHex(mapGrid, q, r)) {
    case "SingleCity":
      return { cities: 1, towns: 0 };
    case "DoubleCity":
      return { cities: 2, towns: 0 };
    case "SingleTown":
      return { cities: 0, towns: 1 };
    case "DoubleTown":
      return { cities: 0, towns: 2 };
    default:
      return NO_CENTRES;
  }
}

/* ------------------------------------------------------------------ */
/* Letter codes                                                       */
/* ------------------------------------------------------------------ */

/** The letter code printed on a hex, restricting which artwork may upgrade
 *  it. `null` for the ordinary majority of the board. */
export type HexLabelRestriction = "OO" | "B" | "NY" | "TO";

/** Which code, if any, this hex carries -- resolved STRUCTURALLY. Design note #1: this used to be two hardcoded
 *  coordinate sets. It now derives the answer the way the renderer's restriction-badge pass does -- OO
 *  membership first, then a landmark's archetype, where a two-station landmark is "NY" and a one-station
 *  landmark is "B". Baltimore is classified by the shape of its printed track rather than because somebody
 *  remembered to list it, and a hypothetical fourth landmark would classify correctly with no edit here. */
export function hexLabelRestriction(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
): HexLabelRestriction | null {
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  // #1317: a TO hex is an OO-shaped hex with a different letter; the letter is asked first.
  if (boardHex && TO_HEXES.has(boardHex.label)) return "TO";
  if (boardHex && YELLOW_OO_HEXES.has(boardHex.label)) return "OO";
  const isLandmark = LANDMARK_HEXES.some((landmark) => landmark.q === q && landmark.r === r);
  if (!isLandmark) return null;
  return archetypeForHex(mapGrid, q, r) === "DoubleCity" ? "NY" : "B";
}

/** The one terrain tag a labelled hex accepts. Still expressed as terrain rather than tile ids, matching
 *  `hexmap.rs` module doc #27: neither the reservation match nor the base-value lookup cares which specific
 *  `tile_id` backs a hub entry -- only the terrain tag itself. */
const REQUIRED_TERRAIN: Readonly<Record<HexLabelRestriction, string>> = {
  OO: "DoubleCityHub",
  B: "BostonHub",
  NY: "NewYorkHub",
  TO: "TorontoHub", // #1317
};

/** Every terrain that is label-restricted somewhere, and therefore illegal
 *  on an unlabelled hex. Derived from `REQUIRED_TERRAIN` rather than
 *  restated, so the two cannot disagree. */
const RESTRICTED_TERRAINS: ReadonlySet<string> = new Set(Object.values(REQUIRED_TERRAIN));

/* ------------------------------------------------------------------ */
/* Tiers                                                              */
/* ------------------------------------------------------------------ */

/** Ascending colour order. Mirrors `hexmap.rs`'s tier progression: a tile
 *  may only upgrade to EXACTLY one step above what is already there. */
const TIER_RANK: Readonly<Record<TileColorTier, number>> = {
  Yellow: 0,
  Green: 1,
  Brown: 2,
  Gray: 3, // #1312: reached only in a Project 18XX+ tile-set game's Diesel era
};

/* Design note #3: A PREPRINTED HEX IS ALREADY AT A TIER. The labelled hexes carry `printedColor: "Yellow"` --
   the board ships with their yellow tile already on it -- but a preprint is not a `MapTileEntry`, so the tile
   grid has no row for them and a naive read sees them as bare ground.
   They are RANK 0, which has two consequences, both requirements rather than conveniences: their first legal
   upgrade is GREEN, because a yellow tile cannot be laid on a hex that already has one; and a BROWN tile is
   not offered until a green one is down -- without the rank, a Brown-era game would have offered brown
   straight onto a still-yellow New York, which is `InvalidColorUpgrade` on chain. */
const preprintedTierByLabel = boardMemo(
  (board): ReadonlyMap<string, TileColorTier> =>
    new Map(
      board.hexes.flatMap((hex) =>
        hex.printedColor === "Yellow" ? ([[hex.label, "Yellow"]] as [string, TileColorTier][]) : [],
      ),
    ),
);

/* ------------------------------------------------------------------ */
/* Track segments -- design note #4                                   */
/* ------------------------------------------------------------------ */

/* Design note #4: STRICT PATH PRESERVATION. The weaker form -- "the new tile's live EDGE SET must be a
   superset of the old one's" -- is necessary but not sufficient, and the gap is real: a yellow tile running
   0-2 and 3-5 upgraded by a green tile wired 0-3 and 2-5 passes the edge test perfectly while rerouting every
   train through the hex. Nothing was deleted; everything was reconnected, and the edge test never looks at
   what connects to what.
   SO THE COMPARISON IS ON SEGMENTS -- pairs of endpoints, each an edge or `CITY`, every one of the old tile's
   appearing on the new.
   SOURCES, in precedence order: (1) `TileCatalogEntry.paths`, the real backend mirror and in practice the only
   branch that ever runs -- MEASURED, all 46 tiles carry it; (2) authored artwork; (3) a two-edge tile's mask.
   2 AND 3 ARE UNREACHABLE TODAY and are kept deliberately, as the degradation path for a catalog entry added
   without `paths`: without them such a tile returns `null` and silently drops to the weaker edge test with
   nothing to indicate the check had been downgraded. Defensive, not load-bearing.
   HOW HUBS ARE MODELLED, and it is better than a spoke list: the backend expands a city hub to its full
   PAIRWISE set, which states directly what a spoke pair only implies -- edge 0 reaches edge 3 THROUGH the city
   -- and means a comparison never has to reason about city identity at all.
   STRICTLY STRONGER THAN THE EDGE TEST, verified rather than asserted: tile #70 at rotation 0 passes the
   edge-superset test over #57 and is rejected by this one. */

/** The non-edge endpoint of a spoke: the tile's own city/town centre. */
export const CITY_ENDPOINT = -1;

/** One track segment, as a sorted endpoint pair. */
export type TileSegment = readonly [number, number];

const segmentKey = (a: number, b: number): string => (a <= b ? `${a}:${b}` : `${b}:${a}`);

/** This tile's internal routing at `orientation`, or `null` when it cannot
 *  be derived -- see design note #4 for the three sources and the gap. */
export function tileSegments(tileId: number, orientation: number): TileSegment[] | null {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  if (!entry) return null;
  const rot = ((orientation % 6) + 6) % 6;
  const turn = (edge: number) => (edge + rot) % 6;

  // 1. The mirrored backend path list.
  if (entry.paths && entry.paths.length > 0) {
    return entry.paths.map(([a, b]) => [turn(a), turn(b)] as const);
  }

  // 2. Authored artwork, including hub spokes.
  const pairs = tileArtworkEdgePairs(tileId);
  if (pairs.length > 0) {
    const out: TileSegment[] = [];
    for (const pair of pairs) {
      if (!pair) continue;
      const a = pair[0] === null ? CITY_ENDPOINT : turn(pair[0]);
      const b = pair[1] === null ? CITY_ENDPOINT : turn(pair[1]);
      out.push([a, b] as const);
    }
    if (out.length > 0) return out;
  }

  // 3. A two-edge tile is unambiguous.
  const edges = liveEdges(rotateConnections(entry.connections, rot));
  if (edges.length === 2) return [[edges[0], edges[1]] as const];

  return null;
}

/* ==================================================================
    DESIGN NOTE 1621 (Slice 9.2, S9-10 / F-2): THE BOARD IS TOPOLOGY TOO
   ==================================================================

   `preservesRouting` was fed `TILE_CATALOG_BY_ID.get(laid.tile_id)` and nothing else, so rule 5 was SKIPPED
   ENTIRELY on every first lay over a hex whose track is printed on the BOARD rather than carried by a tile.
   Revised 6.2.2 ❸ does not care which of the two is holding the rail: "All track segments on the replaced
   tile must be maintained in the same orientations on the new tile."

   IT WAS NOT LATENT. Stage 9.1 found the three landmark hexes masked by `staysOnBoard` ON THE STANDARD
   BOARD and warned the masking "breaks if any board edit gives I15, E23 or G19 a neighbour it currently
   lacks". The edit had already happened: on the expansion Baltimore I15 has all six neighbours, so the
   wrong-parity facings survive the rim test and SIX track-deleting lays are accepted there (three on the
   Level Playing Field, where #592 is out of the tray). Measured, not assumed -- see the Stage-9.2 suite.

   SO THE QUESTION BECOMES "WHAT TOPOLOGY IS ON THIS HEX RIGHT NOW", and it is asked in ONE place.
   `priorTopologyAt` resolves it in `liveEdgesForHex`'s own order -- laid tile (a `printedTile` IS a laid
   tile, #1301) ▸ gray ▸ off-board ▸ landmark ▸ nothing -- so the route graph and the lay predicate cannot
   disagree about what track exists. REPLACEMENT, NOT UNION: this board's semantics are that a laid tile IS
   the hex's topology (`liveEdgesForHex`, `archetypeForHex` and `traversalSegments` all say so by asking the
   tile first and stopping), and unioning a printed print with the tile that replaced it would demand a
   brown OO keep the yellow hex's two severed stubs forever. */

/** The topology a hex carries at this instant, whatever is holding it. */
export interface HexTopology {
  /** Every live edge, as a six-bit mask -- the `hexmap.rs` #10 invariant's left-hand side. */
  mask: number;
  /** Internal routing in `tileSegments`' convention: `[a, b]` is a run between two edges, `[e, e]` a
   *  terminus that enters at `e` and stops (design note #676). `null` when it cannot be derived. */
  segments: TileSegment[] | null;
  /** Which arm answered. Exported so a test can pin the fallback order rather than infer it. */
  source: "laid" | "gray" | "offboard" | "landmark";
  /** #1628 (S9-19): edge groups this hex's CURRENT tile insists stay mutually disconnected through an
   *  upgrade, already rotated to board edges. Present only when the tile carries `separateSystems`, which
   *  today is old #59 alone. `undefined` means the ordinary rules and nothing more -- a landmark's two
   *  severed city stubs (New York) are deliberately NOT this, because ❹ does not name them. */
  separateSystems?: readonly (readonly number[])[];
}

const sortedUnique = (edges: readonly number[]): number[] =>
  Array.from(new Set(edges)).sort((a, b) => a - b);

/** Spokes meeting at the hex's own centre marker: the full PAIRWISE set, which is how this codebase states
 *  a hub everywhere else (`TileCatalogEntry.paths` for #53, `printedPathsForTraversal` for the warehouses).
 *  A single spoke is a terminus, and two spokes are one path -- both fall out of the same expansion. */
const pairwiseThroughCentre = (edges: readonly number[]): TileSegment[] => {
  const unique = sortedUnique(edges);
  if (unique.length === 0) return [];
  if (unique.length === 1) return [[unique[0], unique[0]] as const];
  const out: TileSegment[] = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) out.push([unique[i], unique[j]] as const);
  }
  return out;
};

/** Each stub enters and stops. What a red off-board area IS -- `trackSegments.ts` #484 answers `null` for
 *  one before it even looks at the tile, because terminality is a property of the board. */
const stubsThatEnd = (edges: readonly number[]): TileSegment[] =>
  sortedUnique(edges).map((edge) => [edge, edge] as const);

/** What track stands on `(q, r)` before this action -- design note #1621.
 *
 *  `null` means "nothing, or nothing derivable", and rule 5 then has no opinion, exactly as it had none for
 *  a bare hex before. The order is `liveEdgesForHex`'s, deliberately: a THIRD classifier of what a hex
 *  carries is how the route graph and the legality predicate start answering differently. */
export function priorTopologyAt(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
): HexTopology | null {
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  if (laid) {
    const entry = TILE_CATALOG_BY_ID.get(laid.tile_id);
    /* A tile id the mirror has not caught up to says NOTHING rather than falling through to the board's own
       print. The hex is covered; claiming the printed rail is still under there would be inventing topology,
       and "no opinion" is the direction this file fails in (design note #0). */
    if (!entry) return null;
    const rot = ((laid.orientation % 6) + 6) % 6;
    return {
      mask: rotateConnections(entry.connections, laid.orientation) & 0b111111,
      segments: tileSegments(laid.tile_id, laid.orientation),
      source: "laid",
      /* #1628 (S9-19): read off the tile's own metadata, rotated to the facing it was laid at. Only the LAID
         arm carries it -- the board's printed arms describe track the board prints, and revised 6.2.2 ❹'s
         separation clause is about a (59) TILE. */
      separateSystems:
        entry.separateSystems === true && entry.cityGroups
          ? entry.cityGroups.map((group) => group.map((edge) => (edge + rot) % 6))
          : undefined,
    };
  }

  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex) {
    const grayTrack = GRAY_HEXES[boardHex.label];
    if (grayTrack) {
      return {
        mask: maskOf(grayTrack.edges),
        segments: pairwiseThroughCentre(grayTrack.edges),
        source: "gray",
      };
    }
    const offboardEdges = OFFBOARD_TRACKS[boardHex.label];
    if (offboardEdges) {
      return {
        mask: maskOf(offboardEdges),
        /* #1320: a Level Playing Field warehouse is a red area a route runs THROUGH -- its stubs meet at a
           dit -- while every other red area is where a route ENDS. */
        segments:
          boardHex.warehouse === true
            ? pairwiseThroughCentre(offboardEdges)
            : stubsThatEnd(offboardEdges),
        source: "offboard",
      };
    }
  }

  const landmark = LANDMARK_HEXES.find((entry) => entry.q === q && entry.r === r);
  if (landmark) {
    const cities = LANDMARK_TRACKS[landmark.name] ?? [];
    if (cities.length === 0) return null;
    /* ONE ENTRY PER CITY, and the split is the point. New York is `[{edges:[1]}, {edges:[4]}]` -- two
       revenue centres with NO track joining them -- which expands to two TERMINI, precisely #59's own
       `paths: [[0,0],[2,2]]` encoding, so #676's relaxation applies and the upgrade that CONNECTS them stays
       legal. Baltimore's single city `{0,4}` expands to the one path `(0,4)`, which is the rail that must
       survive. Nothing here is keyed on a landmark's name. */
    const segments = cities.flatMap((city) => pairwiseThroughCentre(city.edges));
    const mask = maskOf(cities.flatMap((city) => [...city.edges]));
    if (mask === 0) return null;
    return { mask, segments, source: "landmark" };
  }

  return null;
}

const maskOf = (edges: readonly number[]): number =>
  edges.reduce((mask, edge) => mask | (1 << (((edge % 6) + 6) % 6)), 0) & 0b111111;

/** Does `candidate` preserve every segment the hex runs today?
 *
 *  Falls back to the edge-superset test when either side's routing cannot
 *  be derived -- design note #4's stated gap. */
function preservesRouting(
  prior: HexTopology,
  candidate: TileCatalogEntry,
  candidateOrientation: number,
): boolean {
  // The edge test is a NECESSARY condition either way, and it is the whole
  // test when routing is underivable. `hexmap.rs` module doc comment #10,
  // verbatim: "old_actual & !new_actual == 0".
  const oldMask = prior.mask;
  const newMask = rotateConnections(candidate.connections, candidateOrientation);
  if ((oldMask & ~newMask & 0b111111) !== 0) return false;

  const oldSegments = prior.segments;
  const newSegments = tileSegments(candidate.tileId, candidateOrientation);
  if (!oldSegments || !newSegments) return true;

  const available = new Set(newSegments.map(([a, b]) => segmentKey(a, b)));
  /* Design note #676: A TERMINUS IS NOT A PATH, AND `[e, e]` IS A TERMINUS.
     FOUND BY the derived upgrade graph (`utils/tileUpgrades.ts` #675), which swept the tray and reported that
     green #59 -- the OO tile -- had no brown successor at all. Not a display fault: this function is what the
     board asks, so the four OO hexes (E5, D10, E11, H18) were frozen at green for the whole game.
     THE CATALOG IS RIGHT AND THE COMPARISON WAS WRONG. #59 carries `paths: [[0, 0], [2, 2]]`, which is the
     backend saying what `hexBoardData` #391 says in prose: two revenue-earning cities with NO track joining
     them, each edge running in and stopping. A self-loop is the honest encoding of "ends here".
     Compared literally, that demanded the brown tile ALSO carry `0:0` -- and #64 through #68 carry `[[0, 2],
     [3, 4]]` and friends, because connecting the two cities is precisely what the upgrade is FOR. Strict
     preservation was reading an addition as a severance.
     SO A SELF-LOOP IS SATISFIED BY THE EDGE SURVIVING, which the mask test above has already established:
     `old_actual & !new_actual == 0` guarantees every edge the old tile carried is still carried. Nothing is
     weakened -- a real path `[a, b]` with `a !== b` is still compared exactly, and the mask test still gates
     everything. What changes is that a terminus stops being asked to remain a terminus.
     ON THE ALTERNATIVE of encoding spurs as `[e, CITY_ENDPOINT]` instead: that is the ARTWORK's convention
     (`tileArtworkEdgePairs(59)` returns `[[0, null], [2, null]]`) and the two are both legitimate. Changing the
     catalog would mean editing the mirror away from the Rust source it mirrors, which is the one thing this
     file's whole design forbids. The comparison is ours; the mirror is not. */
  return oldSegments.every(([a, b]) => a === b || available.has(segmentKey(a, b)));
}

/* ==================================================================
    DESIGN NOTE 1628 (Slice 9.3, S9-19): THE SEPARATION CLAUSE
   ==================================================================

   `preservesRouting` above asks whether every segment the hex runs today SURVIVES. It cannot ask whether two
   of them became ONE, because a self-loop is satisfied by its edge surviving (#676) and a real path is
   compared as a pair -- neither comparison has any notion of which city an exit lands in. So an upgrade that
   keeps both of #59's stubs AND joins them through the destination's own track reads as a pure addition, and
   is accepted. That is exactly the over-acceptance Stage 9.1 measured: seven (tile, facing) pairs.

   THIS IS THE ONLY RULE IN THE FILE THAT COMPARES CONNECTIVITY RATHER THAN SEGMENTS, and it runs only for a
   prior that ASKED for it (`HexTopology.separateSystems`, from `TileCatalogEntry.separateSystems`). A prior
   without the flag reaches `true` on the first line and pays one property read.

   THE DESTINATION'S CONNECTIVITY, not its city list. `cityGroups` is frontend-only artwork bookkeeping and
   #883 does not carry it at all; `paths` is the mirrored backend routing that `hexmap::pathfinding` itself
   walks, every one of the 76 entries has it, and a city hub appears there as the full pairwise expansion of
   its live edges (`TileCatalogEntry.paths` #119). So "are these two edges joined by this tile" is exactly
   "are they in one component of `tileSegments`", and a hub answers yes without being special-cased.

   WHY A TERMINUS DOES NOT UNION. `[e, e]` is #676's "enters at e and stops"; unioning it with itself is a
   no-op, which is the honest reading -- a stub joins an edge to nothing. `CITY_ENDPOINT` (-1) can only arrive
   from the ARTWORK fallback, which collapses every centre of a multi-city tile onto one sentinel; unioning
   through it would invent a connection the artwork never claimed, so it is dropped. No catalog tile reaches
   that fallback (`stage93TileAuthority.test.ts` pins that every entry has `paths`), and if one ever does the
   honest answer is "these edges are not known to be joined" rather than a fabricated merge. */

/** The connected components of `tileId`'s own track at `orientation`, as board-edge groups. */
export function tileEdgeComponents(tileId: number, orientation: number): number[][] {
  const entry = TILE_CATALOG_BY_ID.get(tileId);
  if (!entry) return [];
  const segments = tileSegments(tileId, orientation);
  const parent = new Map<number, number>();
  const find = (edge: number): number => {
    const seen = parent.get(edge);
    if (seen === undefined || seen === edge) return edge;
    const root = find(seen);
    parent.set(edge, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const edge of liveEdges(rotateConnections(entry.connections, orientation))) parent.set(edge, edge);
  for (const [a, b] of segments ?? []) {
    if (a === CITY_ENDPOINT || b === CITY_ENDPOINT || a === b) continue;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    union(a, b);
  }
  const groups = new Map<number, number[]>();
  for (const edge of Array.from(parent.keys()).sort((a, b) => a - b)) {
    const root = find(edge);
    groups.set(root, [...(groups.get(root) ?? []), edge]);
  }
  return Array.from(groups.values());
}

/** Does `candidate` at this facing keep the prior's separated systems apart?
 *
 *  `true` whenever the prior names none, which is every hex on the board but one holding a #59. */
export function separationPreserved(
  prior: HexTopology,
  candidate: TileCatalogEntry,
  candidateOrientation: number,
): boolean {
  const systems = prior.separateSystems;
  if (!systems || systems.length < 2) return true;
  const components = tileEdgeComponents(candidate.tileId, candidateOrientation);
  const componentOf = (edge: number): number => components.findIndex((group) => group.includes(edge));
  for (let i = 0; i < systems.length; i += 1) {
    for (let j = i + 1; j < systems.length; j += 1) {
      for (const a of systems[i]) {
        for (const b of systems[j]) {
          const ca = componentOf(a);
          const cb = componentOf(b);
          if (ca !== -1 && ca === cb) return false;
        }
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Station tokens                                                     */
/* ------------------------------------------------------------------ */

/** Whether a station token may target this hex. A token needs a CITY -- towns do not take tokens, and neither
 *  does plain track. Expressed as a count rather than a terrain list so it follows the same metadata path as
 *  everything else here; `execute_place_station_token`'s own gate is the terrain equivalent. */
export function isTokenableHex(mapGrid: MapGridResponse, q: number, r: number): boolean {
  return hexCentres(mapGrid, q, r).cities > 0;
}

/* ------------------------------------------------------------------ */
/* The filter                                                         */
/* ------------------------------------------------------------------ */

export interface SandboxLegalityContext {
  /** The board, for resolving the hex's archetype and any laid tile. */
  mapGrid: MapGridResponse;
  q: number;
  r: number;
  /** The room's unlocked tier -- Phase 2 is `Yellow`, Phases 3-4 `Green`,
   *  Phase 5+ `Brown`. Derived by the caller from `gamePhase.ts` so there is
   *  one phase-to-era mapping in the app, and it is the one the phase badge
   *  already displays. */
  era: TileColorTier;
  /* Design note #6: AN ORIENTATION HAS TO JOIN THE NETWORK. `App.tsx #173` already restricted rotation to the
     angles this returns, so the cycle was never walking all six blindly -- what it was missing is that every
     check above is about the TILE and the HEX, and none of them asks the question a player actually has: does
     the track come out where my network is?
     A #9 straight beside Altoona is a legal tile on a legal hex at three rotations and connects to PRR at
     exactly one. Offering the other two is offering placements the contract rejects, and it makes the rotate
     gesture feel arbitrary.
     OPTIONAL, and omitted means unchecked: a caller with no network to measure gets exactly the previous
     behaviour rather than an empty carousel. */
  networkHexes?: ReadonlySet<string>;
  /* Design note #483: THE EDGE, NOT JUST THE HEX. The network hex set alone was not enough. The old check asked
     two questions -- is the neighbour a network hex, and does it carry rail to the shared edge -- and BOTH are
     true of the far arm of a crossover the corporation cannot reach: tile #20 is two separate straights, so a
     corporation meeting edge 0 puts the hex in the network and edge 1 is a live edge of that same hex.
     `trackReach`'s PORTS carry the answer the walk already had -- the edges the corporation's own continuous
     track arrives at. Facing a port is the real join.
     SUPPLIED TOGETHER OR NOT AT ALL, so a caller cannot hold a fresh hex set and a stale port set. */
  networkPorts?: ReadonlySet<string>;
}

/** Narrow the unfiltered 46-tile tray to what could plausibly be laid here. Sandbox only -- design note #0.
 *  Five rules, in the order the contract checks them:
 *    1. ERA -- a tile above the room's unlocked tier is `EraLocked` on chain.
 *    2. CENTRE MATCH, WITH TOWN PARITY -- a town hex takes a tile with the SAME NUMBER of towns, never a swap,
 *       because a double-town hex prints two separate revenue stops and a one-town tile would erase one.
 *    3. LETTER CODE -- a labelled hex takes only its own artwork family, and that family is illegal anywhere
 *       else. Scoped to Green and Brown: a labelled hex's yellow start is the ordinary shared hub artwork.
 *    4. COLOUR STEP -- exactly one tier above what is there, with bare ground counting as -1 so "only start
 *       with yellow" and "only upgrade one step" are the same rule. A preprinted hex counts as its tier (#3).
 *    5. PATH PRESERVATION (#4) -- the only rule judged per ORIENTATION rather than per tile.
 *  What this deliberately does NOT check, because it cannot without becoming the rules engine the brief rules
 *  out: network connectivity, city reservation for unfloated home hexes, and tray depletion. The tray is
 *  narrowed to plausible, not proven.
 *  The orientation join (#6) is ONE-SIDED, matching `trackReach`'s extension rule: the neighbour must be a
 *  network hex whose own rail reaches the shared edge, and the tile being laid supplies the other half. A hex
 *  ALREADY in the network is an upgrade rather than an extension, judged by check 5, so it passes here
 *  unconditionally. */
function orientationJoinsNetwork(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  entry: TileCatalogEntry,
  orientation: number,
  networkHexes: ReadonlySet<string>,
  networkPorts: ReadonlySet<string> | undefined,
): boolean {
  if (networkHexes.has(`${q},${r}`)) return true;

  for (const edge of liveEdges(rotateConnections(entry.connections, orientation))) {
    const offset = HEX_NEIGHBOR_OFFSETS[edge];
    if (!offset) continue;
    const nq = q + offset[0];
    const nr = r + offset[1];
    if (!networkHexes.has(`${nq},${nr}`)) continue;
    const shared = (edge + 3) % 6;
    if (networkPorts) {
      /* Design note #483: the strict test. The corporation's track must
         REACH the shared edge from inside the neighbour, which is what a
         port records -- not merely that some rail on that hex touches it. */
      if (networkPorts.has(portKey(nq, nr, shared))) return true;
      continue;
    }
    /* No port set supplied. Fall back to the edge test, which is what this
       function did before design note #483 -- looser, and the looser
       direction is the safe one here: it can only OFFER an orientation the
       contract will refuse, never hide a legal one. */
    if (liveEdgesForHex(mapGrid, nq, nr).includes(shared)) return true;
  }
  return false;
}

/* Design note #7: TRACK CANNOT RUN OFF THE EDGE OF THE BOARD. Nothing in this filter had any notion of where
   the board ENDS -- every other test asks about the tile or the hex it is going on, and none asks whether the
   hex on the other side of a proposed connection exists.
   Measured before the fix: F20 has one edge pointing at a coordinate that is not on the board, and 34 of the
   72 yellow tile-and-orientation combinations offered there put track on it. Thirty-four board hexes have at
   least one such edge, so this is a whole rim of the map rather than one awkward corner.
   A rail to nowhere is track the corporation paid for that can never carry a train, presented beside legal
   rotations with nothing to tell them apart.
   THE RED OFF-BOARD HEXES ARE ON THE BOARD -- real coordinates that track may legally point at, since they are
   where routes terminate. So the test is membership of the board's own coordinate set, not "is this hex
   playable", and getting that backwards would forbid every connection to the map's most valuable destinations. */
function staysOnBoard(
  q: number,
  r: number,
  entry: TileCatalogEntry,
  orientation: number,
): boolean {
  for (const edge of liveEdges(rotateConnections(entry.connections, orientation))) {
    const offset = HEX_NEIGHBOR_OFFSETS[edge];
    if (!offset) continue;
    if (!isBoardHex(q + offset[0], r + offset[1])) return false;
  }
  return true;
}

/* ==================================================================
 *  DESIGN NOTE 756: THE FOUR BARRIERS WERE DRAWN AND NOT ENFORCED
 * ==================================================================
 *
 * REPORTED: "On the Lay Track action, there are four impassable barriers on the map: it should not be legal
 * to rotate a tile so that its tracks run into these barriers, in the same way they cannot run off the
 * board."
 *
 * THE COMPARISON IS EXACT AND SO IS THE FIX. #7 is the off-board rule -- "TRACK CANNOT RUN OFF THE EDGE OF
 * THE BOARD. Nothing in this filter had any notion of where the board ENDS" -- and this is the same absence
 * one step in from the rim: a rail pointing at a barrier is track the corporation paid for that can never
 * carry a train, offered beside legal rotations with nothing to tell them apart.
 *
 * THE DATA WAS ALREADY HERE, LABELLED AS DECORATION. `IMPASSABLE_BORDER_EDGES` calls itself "a drawing-only
 * mirror of the backend's enforcement table", and it was telling the truth: `hexmap.rs` refuses these lays
 * and the sandbox drew a line across the hex and allowed them. The familiar shape, arriving through a table
 * that documented its own gap in its first six words.
 *
 * THE MIRROR IS DERIVED, NOT TRANSCRIBED. The drawing table lists each barrier ONCE, from one side; refusing
 * a lay needs both sides, because the tile being rotated may sit on either. Rather than copy the Rust
 * table's eight entries by hand -- a transcription with four chances to invert an edge index -- the second
 * side is computed: the neighbour across edge `e` is blocked on edge `(e + 3) % 6`. The harness then checks
 * the derived set against the contract's own list, so the arithmetic is verified rather than trusted. */
const IMPASSABLE_EDGE_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const border of IMPASSABLE_BORDER_EDGES) {
    keys.add(`${border.q},${border.r},${border.edge}`);
    const offset = HEX_NEIGHBOR_OFFSETS[border.edge];
    if (!offset) continue;
    /* The opposite edge, which on a hex is three steps round. Stated as arithmetic rather than as a lookup
       table because a six-entry table of "the other side of edge N" is a second place for the edge
       numbering to be wrong. */
    keys.add(`${border.q + offset[0]},${border.r + offset[1]},${(border.edge + 3) % 6}`);
  }
  return keys;
})();

/** Exported for the harness, which pins it against `hexmap.rs`'s `IMPASSABLE_HEX_EDGES`. */
export function isImpassableEdge(q: number, r: number, edge: number): boolean {
  return IMPASSABLE_EDGE_KEYS.has(`${q},${r},${edge}`);
}

/** Whether this tile, at this rotation, would put rail across one of the four barriers.
 *
 *  ONE-SIDED IS ENOUGH HERE, unlike `staysOnBoard`'s neighbour lookup: the set already contains both sides,
 *  so asking about the hex being laid on answers for either direction of approach. */
function crossesImpassableBorder(
  q: number,
  r: number,
  entry: TileCatalogEntry,
  orientation: number,
): boolean {
  for (const edge of liveEdges(rotateConnections(entry.connections, orientation))) {
    if (isImpassableEdge(q, r, edge)) return true;
  }
  return false;
}

export function filterSandboxPlacements(
  placements: readonly LegalTilePlacement[],
  { mapGrid, q, r, era, networkHexes, networkPorts }: SandboxLegalityContext,
): LegalTilePlacement[] {
  /* ==================================================================
      RULE 0. THE HEX ITSELF -- design note #1620 (Slice 9.2, S9-10 / F-1)
     ==================================================================
     Ported from `hexmap.rs` IN ITS ORDER: off-board (`:2317`) then gray (`:2331`), both ahead of every
     geometric rule below, because each is disjoint from and more absolute than all of them. Hoisted out of
     the per-placement loop because it is a fact about the HEX -- no tile, no facing and no era can change
     it, and refusing 456 placements one at a time would only say the same thing 456 times.
     THE MESSAGE AND THE REFUSAL ARE ONE ANSWER: `evaluateHexForTileLaying` (the click/glow predicate) asks
     the same function, so what a player is told and what a replay applies cannot drift apart. */
  if (immutableHexRefusal(q, r) !== null) return [];

  const restriction = hexLabelRestriction(mapGrid, q, r);
  const wanted = hexCentres(mapGrid, q, r);
  const eraRank = TIER_RANK[era];

  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  const existing = laid ? TILE_CATALOG_BY_ID.get(laid.tile_id) : undefined;
  /* #1621: the topology rule 5 must preserve -- the laid tile when there is one, the BOARD's own print when
     there is not. Resolved once per hex rather than per candidate; it does not depend on the tile offered. */
  const prior = priorTopologyAt(mapGrid, q, r);

  // Design note #3: a laid tile wins, then the hex's printed tier, then
  // bare ground at -1.
  const preprintedTier = boardHex ? preprintedTierByLabel().get(boardHex.label) : undefined;
  const existingRank = existing
    ? TIER_RANK[existing.color]
    : preprintedTier === undefined
      ? -1
      : TIER_RANK[preprintedTier];

  return placements.filter(({ tile_id, orientation }) => {
    const entry = TILE_CATALOG_BY_ID.get(tile_id);
    // An id absent from the mirror is a catalog gap, not a legal tile. The
    // renderer draws these as an explicit placeholder rather than guessing
    // artwork; offering one would let a player select a tile nobody can
    // render.
    if (!entry) return false;

    /* ==================================================================
        DESIGN NOTE 1311: THE TRAY IS ASKED FIRST
       ==================================================================
       0a. IN THIS GAME AT ALL. The catalog now carries every tile either game can hold, so a tile that is
       not in this table's tray -- a green town at a standard table, say -- must be refused here, before
       any geometric rule gets to find it legal.
       0b. AND STILL IN THE BOX. RULED: the reducer refuses a lay when the tray is empty -- it was the radial
       selector's disabled button alone before, which was fine while a contract had the last word and is
       not now that the Node server is the authority. The arithmetic is `tileSupply`'s own closed one: a
       copy is on the board or in the tray, a printed tile (#1301) never left the tray, and the tile being
       replaced by this lay goes back. A properly-played log cannot have laid past the count, so no replay
       moves. */
    if (!inTray(tile_id)) return false;
    const onBoard = mapGrid.tiles.reduce(
      (total, tile) => (tile.tile_id === tile_id && tile.printed !== true ? total + 1 : total),
      0,
    );
    if (onBoard >= trayCountOf(tile_id)) return false;

    // 1. Era.
    if (TIER_RANK[entry.color] > eraRank) return false;

    // 2. Centres, with town parity.
    const centres = tileCentres(tile_id);
    if (wanted.cities > 0) {
      if (centres.cities === 0) return false;
    } else if (wanted.towns > 0) {
      /* ==================================================================
          DESIGN NOTE 1403: TWO TOWNS MAY BECOME ONE, AND WHICH GREEN TOWN TAKES WHICH HEX
         ==================================================================
         RULED, the full small-town chart: yellow 3/4/58 -> 141-144; yellow 1/2/55/56/69/630-633 -> 87/88/204;
         green 141/142 -> 145/146/147, 143 -> 146/147, 144 -> 147, 88 -> 145, 87 -> 146, 204 -> 147.
         THIS READ "EXACT parity", so a two-town yellow had no green at all: every green town carries one
         dit, and the double towns' greens (#87/#88/#204) are that one dit standing for both, with all four
         exits kept. So a town hex may keep its count or MERGE to one -- never gain a town -- and the tile
         says which family it is: `mergesTowns` marks the three that stand for two, laid over a two-town hex
         only; the three-exit greens (#141-#144) take a one-town hex only. Geometry (rule 5) settles the rest
         of the chart: it is why 4 reaches 141 and 142 but not 143, and why 144 reaches 147 alone. */
      if (centres.towns === 0 || centres.towns > wanted.towns) return false;
      if (entry.mergesTowns === true && wanted.towns !== 2) return false;
      if (entry.mergesTowns !== true && centres.towns !== wanted.towns) return false;
    } else if (centres.cities > 0 || centres.towns > 0) {
      return false;
    }

    // 3. Letter code.
    if (restriction) {
      if (entry.color !== "Yellow" && entry.terrain !== REQUIRED_TERRAIN[restriction]) return false;
    } else if (RESTRICTED_TERRAINS.has(entry.terrain)) {
      return false;
    }

    // 4. Colour step.
    if (TIER_RANK[entry.color] !== existingRank + 1) return false;

    // 4b. Design note #7: no rail pointing off the edge of the board.
    if (!staysOnBoard(q, r, entry, orientation)) return false;

    /* 4c. Design note #756: and none pointing into one of the four impassable borders. Beside #7 rather than
       folded into it, because the two rules answer different questions -- "is there a hex there" and "may
       track cross into it" -- and a hex on the far side of a barrier is perfectly real. */
    if (crossesImpassableBorder(q, r, entry, orientation)) return false;

    /* 5. Path preservation, per orientation -- #1621: over the hex's LIVE topology, which is the laid tile
       where one stands and the board's own printed track where none does. */
    if (prior && !preservesRouting(prior, entry, orientation)) {
      return false;
    }

    /* 5b. Separation, per orientation -- #1628 (S9-19). Beside rule 5 rather than inside it, because the two
       answer different questions: rule 5 asks whether the track that is here SURVIVES, and this asks whether
       two systems that were apart are still apart. A prior that names no separated systems -- every hex but
       one holding a #59 -- returns `true` immediately. */
    if (prior && !separationPreserved(prior, entry, orientation)) {
      return false;
    }

    // 6. Connection to the network, per orientation -- design note #6.
    if (
      networkHexes &&
      !orientationJoinsNetwork(mapGrid, q, r, entry, orientation, networkHexes, networkPorts)
    ) {
      return false;
    }

    return true;
  });
}
