// frontend/src/components/sandboxTileLegality.ts
//
// A LEGALITY FILTER FOR THE OFFLINE SANDBOX TILE PICKER, AND NOWHERE ELSE.
//
// ===================================================================
//  DESIGN NOTE 0: WHY THIS DOES NOT VIOLATE "NO CLIENT-SIDE
//  RE-VALIDATION" -- READ THIS BEFORE EXTENDING IT
// ===================================================================
//
// `TileSelectionPopup.tsx`'s design note #4 sets a hard policy: the
// frontend does NOT re-validate tile legality, because `hexmap.rs`'s
// `legal_tile_placements` already answers that question and a second copy
// of the rules would drift out of sync with the first. `hexmap.rs`'s own
// module doc comment #26 records the same decision from the other side --
// the "B"/"NY"/"OO" restrictions were deliberately NOT mirrored into this
// frontend when they were added.
//
// That policy is about the CONTRACT-BACKED path, and this module does not
// touch it. The contract-backed picker still receives
// `legal_tile_placements` verbatim; nothing here is on that code path.
//
// The sandbox path is a different situation entirely. There is no chain, so
// nothing was ever asked, so `localCatalogPlacements()` returns all 46
// tiles in all 6 orientations with -- in its own words -- "no legality
// claim of any kind". This module is not a SECOND opinion competing with
// the contract's; on this path it is the ONLY opinion, and the alternative
// is not "defer to the contract", it is "offer the player a green
// double-city hub for a plain prairie hex". A filter that exists only where
// no authority is reachable cannot drift from an authority.
//
// The distinction that keeps this honest: the picker's provisional
// labelling STAYS ON. This narrows what is offered; it never promises the
// contract would accept it.
//
// ===================================================================
//  DESIGN NOTE 1: NO TILE IDs, AND NO HEX COORDINATES EITHER
// ===================================================================
//
// Nothing in this file matches on a tile number or a hex label. Both would
// be a third source of truth for facts that already have two (the Rust
// catalog and this frontend's mirror of it), and the one most likely to go
// stale -- adding a Brown OO tile to both catalogs should make it legal
// here automatically, with no list to remember.
//
// Every decision below is a function of METADATA:
//
//   - How many cities and towns a tile carries    -> `tileCentres`
//   - How many the HEX carries                    -> `hexCentres`
//   - Which letter code, if any, the hex prints   -> `hexLabelRestriction`
//   - Which tier a tile or hex is at              -> `TIER_RANK`
//   - Which track segments a tile actually runs   -> `tileSegments`
//
// The hex-side reads all route through `archetypeForHex`, which the
// renderer already uses and which resolves a hex STRUCTURALLY -- a Set
// membership, an enum tag, an array length -- rather than by comparing
// names. Reusing it means a new hex added to the board data classifies
// correctly here without this file being touched.
//
// ===================================================================
//  DESIGN NOTE 2: WHERE THE COUNTS COME FROM
// ===================================================================
//
// Two independent sources agree, and the filter uses the better one:
//
//   AUTHORED MARKERS. `TILE_GRAPHICS_CATALOG[id].markers` lists each
//   revenue centre on a tile with `kind: "city" | "town"`. This is real
//   per-tile artwork data. It covers the 22 hand-authored tiles.
//
//   THE TERRAIN TAG. `TileCatalogEntry.terrain` is mirrored from the Rust
//   catalog entry for entry, and each variant implies an exact pair --
//   `SmallTown` is one town, `DoubleCityHub` is two cities, and so on. It
//   covers all 46.
//
// Markers win where they exist because they are the finer-grained record;
// the tag covers the rest. The two were checked against each other across
// all 22 overlapping tiles and agree on every one, and the harness for this
// pass re-checks that agreement rather than assuming it holds -- a
// disagreement would mean the artwork and the catalog had drifted, which is
// worth failing loudly over.

import { TILE_CATALOG_BY_ID, type TileColorTier, type TileCatalogEntry } from "./hexTileCatalog";
import { LANDMARK_HEXES, STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "./hexBoardData";
import {
  HEX_NEIGHBOR_OFFSETS,
  archetypeForHex,
  liveEdges,
  liveEdgesForHex,
  rotateConnections,
} from "./hexGeometry";
import { TILE_GRAPHICS_CATALOG, tileArtworkEdgePairs } from "./TileGraphics";
import type { LegalTilePlacement, MapGridResponse } from "./hexContractTypes";

/* ------------------------------------------------------------------ */
/* Revenue-centre counts                                              */
/* ------------------------------------------------------------------ */

export interface CentreCounts {
  cities: number;
  towns: number;
}

const NO_CENTRES: CentreCounts = { cities: 0, towns: 0 };

/** What each terrain tag implies. Design note #2's second source.
 *
 *  `MountainRugged` is retained with zero centres because the Rust enum
 *  retains it (no tile carries it since Audit G-5/G-10); dropping it here
 *  would make this map non-total over `TerrainType`. */
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

/** Cities and towns printed on a HEX, in the same units.
 *
 *  Read through `archetypeForHex`, so a laid tile's real terrain wins where
 *  one exists and the hex's own static designation answers otherwise --
 *  OO membership, town/city designation, a gray hex's marker kind, or a
 *  landmark's printed track structure. One classifier, shared with the
 *  renderer, rather than a second reading of the board tables. */
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
export type HexLabelRestriction = "OO" | "B" | "NY";

/** Which code, if any, this hex carries -- resolved STRUCTURALLY.
 *
 *  Design note #1: this used to be two hardcoded coordinate sets
 *  (`{E23, I15}` and `"G19"`). It now derives the answer the same way
 *  `HexGridRenderer`'s own restriction-badge pass does -- OO membership
 *  first, then a landmark's archetype, where a two-station landmark is "NY"
 *  and a one-station landmark is "B". Baltimore is therefore classified as
 *  a "B" hex by the shape of its printed track rather than because
 *  somebody remembered to list it, and a hypothetical fourth landmark would
 *  classify correctly with no edit here. */
export function hexLabelRestriction(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
): HexLabelRestriction | null {
  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  if (boardHex && YELLOW_OO_HEXES.has(boardHex.label)) return "OO";
  const isLandmark = LANDMARK_HEXES.some((landmark) => landmark.q === q && landmark.r === r);
  if (!isLandmark) return null;
  return archetypeForHex(mapGrid, q, r) === "DoubleCity" ? "NY" : "B";
}

/** The one terrain tag a labelled hex accepts.
 *
 *  Still expressed as terrain rather than tile ids, matching `hexmap.rs`
 *  module doc comment #27: "neither the City Reservation match logic nor
 *  `terrain_base_value` cares which specific `tile_id` backs a
 *  `BostonHub`/`NewYorkHub`/`DoubleCityHub` entry -- only the terrain tag
 *  itself." */
const REQUIRED_TERRAIN: Readonly<Record<HexLabelRestriction, string>> = {
  OO: "DoubleCityHub",
  B: "BostonHub",
  NY: "NewYorkHub",
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
};

/* ===================================================================
 *  DESIGN NOTE 3: A PREPRINTED HEX IS ALREADY AT A TIER
 * ===================================================================
 *
 * The labelled hexes -- the four OO hexes, Boston, Baltimore and New York
 * -- carry `printedColor: "Yellow"` in `STATIC_BOARD_HEXES`: the board
 * ships with their yellow tile already on it. But a preprint is not a
 * `MapTileEntry`, so `mapGrid.tiles` has no row for them and a naive read
 * sees them as bare ground.
 *
 * They are RANK 0 (Yellow), which has two consequences, and both are
 * requirements rather than conveniences:
 *
 *   - Their first legal upgrade is GREEN. Yellow is never offered, because
 *     a yellow tile cannot be laid on a hex that already has one.
 *   - A BROWN tile is not offered either until a green one is down. Without
 *     the rank, a Brown-era game would have offered brown straight onto a
 *     still-yellow New York, skipping green entirely --
 *     `InvalidColorUpgrade` on chain.
 */
const PREPRINTED_TIER_BY_LABEL: ReadonlyMap<string, TileColorTier> = new Map(
  STATIC_BOARD_HEXES.flatMap((hex) =>
    hex.printedColor === "Yellow" ? ([[hex.label, "Yellow"]] as [string, TileColorTier][]) : [],
  ),
);

/* ------------------------------------------------------------------ */
/* Track segments -- design note #4                                   */
/* ------------------------------------------------------------------ */

/* ===================================================================
 *  DESIGN NOTE 4: STRICT PATH PRESERVATION
 * ===================================================================
 *
 * An upgrade may not delete track. The weaker form of that check -- "the
 * new tile's live EDGE SET must be a superset of the old one's" -- is
 * necessary but not sufficient, and the gap is real rather than
 * theoretical.
 *
 * Consider a yellow tile whose track runs edge 0 to edge 2 and, separately,
 * edge 3 to edge 5: two parallel routes. A green tile with all four of
 * those edges live but wired 0-to-3 and 2-to-5 passes the edge test
 * perfectly while rerouting every train through the hex. Nothing was
 * deleted; everything was reconnected. The edge test cannot see it, because
 * it never looks at what connects to what.
 *
 * So the comparison is on SEGMENTS. Each is a pair of endpoints, where an
 * endpoint is either an edge (0-5) or `CITY`, and every segment on the old
 * tile must appear on the new one.
 *
 * WHERE THE SEGMENT DATA COMES FROM, in precedence order:
 *
 *   1. `TileCatalogEntry.paths` -- the real backend mirror, and in practice
 *      the only branch that ever runs. MEASURED, not assumed: all 46 tiles
 *      carry it. That contradicts the field's own doc comment in
 *      `hexTileCatalog.ts`, which still says "POPULATED ONLY FOR THE FIVE
 *      DOUBLETOWN TILES" -- true when written, stale since the mirror was
 *      completed. That comment is corrected in place rather than left to
 *      mislead the next reader.
 *   2. Authored artwork (`tileArtworkEdgePairs`), including hub spokes as
 *      edge-to-`CITY_ENDPOINT`.
 *   3. A two-edge tile's mask -- unambiguous: two live edges is exactly one
 *      segment joining them.
 *
 * 2 AND 3 ARE UNREACHABLE TODAY and are kept deliberately. They are the
 * degradation path for a catalog entry added without `paths`: without them
 * such a tile returns `null` and silently drops to the weaker edge test,
 * with nothing to indicate the check had been downgraded. Described as
 * defensive rather than described as load-bearing, because they are not.
 *
 * HOW HUBS ARE MODELLED, and it is better than a spoke list: the backend
 * expands a city hub to its full PAIRWISE set, so #14 (edges 0/1/3/4) is
 * `[0,1] [0,3] [0,4] [1,3] [1,4] [3,4]`. That states directly what a spoke
 * pair only implies -- edge 0 reaches edge 3 THROUGH the city -- and it
 * means a comparison never has to reason about city identity at all.
 * `CITY_ENDPOINT` therefore only appears on the unreachable artwork path.
 *
 * THIS IS STRICTLY STRONGER THAN THE EDGE TEST, verified rather than
 * asserted: tile #70 at rotation 0 passes the edge-superset test over #57
 * and is rejected by this one.
 */

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

/** Does `candidate` preserve every segment `existing` runs?
 *
 *  Falls back to the edge-superset test when either side's routing cannot
 *  be derived -- design note #4's stated gap. */
function preservesRouting(
  existing: TileCatalogEntry,
  existingOrientation: number,
  candidate: TileCatalogEntry,
  candidateOrientation: number,
): boolean {
  // The edge test is a NECESSARY condition either way, and it is the whole
  // test when routing is underivable. `hexmap.rs` module doc comment #10,
  // verbatim: "old_actual & !new_actual == 0".
  const oldMask = rotateConnections(existing.connections, existingOrientation);
  const newMask = rotateConnections(candidate.connections, candidateOrientation);
  if ((oldMask & ~newMask & 0b111111) !== 0) return false;

  const oldSegments = tileSegments(existing.tileId, existingOrientation);
  const newSegments = tileSegments(candidate.tileId, candidateOrientation);
  if (!oldSegments || !newSegments) return true;

  const available = new Set(newSegments.map(([a, b]) => segmentKey(a, b)));
  return oldSegments.every(([a, b]) => available.has(segmentKey(a, b)));
}

/* ------------------------------------------------------------------ */
/* Station tokens                                                     */
/* ------------------------------------------------------------------ */

/** Whether a station token may target this hex.
 *
 *  A token needs a CITY. Towns do not take tokens, and neither does plain
 *  track. Expressed as a count rather than a terrain list so it follows the
 *  same metadata path as everything else here --
 *  `execute_place_station_token`'s own gate is the terrain equivalent
 *  (`hexmap.rs` module doc comment #26). */
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
  /* ==================================================================
   *  DESIGN NOTE 6: AN ORIENTATION HAS TO JOIN THE NETWORK
   * ==================================================================
   *
   * REPORTED BUG: the tile selector rotates through configurations that are
   * not legal here.
   *
   * Design note #173 (App.tsx) already restricted rotation to the angles
   * this function returns, so the cycle was never walking all six blindly.
   * What it was missing is that every check above is about the TILE and the
   * HEX -- era, centre parity, letter code, colour step, path preservation --
   * and none of them asks the question a player actually has: does the track
   * come out where my network is?
   *
   * A #9 straight laid across an empty hex beside Altoona is a legal tile on
   * a legal hex at three of its rotations and connects to PRR at exactly
   * one. Offering the other two is offering placements the contract rejects,
   * and worse, it makes the rotate gesture feel arbitrary: the tile spins
   * through angles that look identical in legality terms and are not.
   *
   * `networkHexes` closes that. An orientation survives only if one of its
   * live edges faces a hex in the corporation's network across an edge that
   * network hex actually carries rail on -- the same one-sided join
   * `trackReach`'s design note #3 describes, applied to a specific rotation
   * rather than to the hex as a whole.
   *
   * OPTIONAL, and omitted means unchecked. A caller without a network to
   * measure -- no token on the board, or a build with no game state yet --
   * gets exactly the previous behaviour rather than an empty carousel. */
  networkHexes?: ReadonlySet<string>;
}

/**
 * Narrow the unfiltered 46-tile tray to what could plausibly be laid here.
 * Sandbox only -- see design note #0.
 *
 * Five rules, in the order the contract checks them:
 *
 *  1. ERA. A tile above the room's unlocked tier is `EraLocked` on chain.
 *
 *  2. CENTRE MATCH, with TOWN PARITY. The tile's printed centres must match
 *     the hex's: plain takes 0 cities and 0 towns, a city hex takes a tile
 *     with cities, and a town hex takes a tile with the SAME NUMBER of
 *     towns -- one town for a one-town hex, two for a two-town hex, never
 *     a swap. Parity matters because the two are different pieces of board:
 *     a double-town hex prints two separate revenue stops and a one-town
 *     tile would erase one of them.
 *
 *  3. LETTER CODE. A labelled hex takes only its own artwork family, and
 *     that family is illegal anywhere else. Scoped to Green and Brown:
 *     `hexmap.rs` #26 records that a labelled hex's "YELLOW start... remain
 *     the ordinary shared hub artwork", with the dedicated artwork existing
 *     from Green up.
 *
 *  4. COLOUR STEP. Exactly one tier above what is there, with bare ground
 *     counting as -1 so "you may only start with yellow" and "you may only
 *     upgrade one step" are the same rule. A preprinted hex counts as its
 *     printed tier -- design note #3.
 *
 *  5. PATH PRESERVATION. Every segment the old tile runs must exist on the
 *     candidate at that rotation -- design note #4. The only rule judged
 *     per ORIENTATION rather than per tile.
 *
 * What this deliberately does NOT check, because it cannot without becoming
 * the rules engine the project brief rules out: network connectivity to the
 * corporation, city reservation for unfloated home hexes, and tray
 * depletion. The tray is narrowed to plausible, not proven.
 */
/** Whether `entry` at `orientation` on `(q, r)` puts track against the
 *  corporation's network -- design note #6.
 *
 *  ONE-SIDED, matching `trackReach`'s extension rule: the neighbour must be
 *  a network hex whose own rail reaches the shared edge. The tile being laid
 *  supplies the other half of the join, which is the whole point of laying
 *  it.
 *
 *  A hex ALREADY in the network is an upgrade rather than an extension, and
 *  an upgrade is judged by path preservation (check 5) rather than by
 *  needing a fresh join -- so it passes here unconditionally. */
function orientationJoinsNetwork(
  mapGrid: MapGridResponse,
  q: number,
  r: number,
  entry: TileCatalogEntry,
  orientation: number,
  networkHexes: ReadonlySet<string>,
): boolean {
  if (networkHexes.has(`${q},${r}`)) return true;

  for (const edge of liveEdges(rotateConnections(entry.connections, orientation))) {
    const offset = HEX_NEIGHBOR_OFFSETS[edge];
    if (!offset) continue;
    const nq = q + offset[0];
    const nr = r + offset[1];
    if (!networkHexes.has(`${nq},${nr}`)) continue;
    // The network hex must carry rail to the edge they share.
    if (liveEdgesForHex(mapGrid, nq, nr).includes((edge + 3) % 6)) return true;
  }
  return false;
}

export function filterSandboxPlacements(
  placements: readonly LegalTilePlacement[],
  { mapGrid, q, r, era, networkHexes }: SandboxLegalityContext,
): LegalTilePlacement[] {
  const restriction = hexLabelRestriction(mapGrid, q, r);
  const wanted = hexCentres(mapGrid, q, r);
  const eraRank = TIER_RANK[era];

  const boardHex = STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r);
  const laid = mapGrid.tiles.find((tile) => tile.q === q && tile.r === r);
  const existing = laid ? TILE_CATALOG_BY_ID.get(laid.tile_id) : undefined;

  // Design note #3: a laid tile wins, then the hex's printed tier, then
  // bare ground at -1.
  const preprintedTier = boardHex ? PREPRINTED_TIER_BY_LABEL.get(boardHex.label) : undefined;
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

    // 1. Era.
    if (TIER_RANK[entry.color] > eraRank) return false;

    // 2. Centres, with town parity.
    const centres = tileCentres(tile_id);
    if (wanted.cities > 0) {
      if (centres.cities === 0) return false;
    } else if (wanted.towns > 0) {
      // EXACT parity, not "has towns".
      if (centres.towns !== wanted.towns) return false;
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

    // 5. Path preservation, per orientation.
    if (existing && !preservesRouting(existing, laid?.orientation ?? 0, entry, orientation)) {
      return false;
    }

    // 6. Connection to the network, per orientation -- design note #6.
    if (networkHexes && !orientationJoinsNetwork(mapGrid, q, r, entry, orientation, networkHexes)) {
      return false;
    }

    return true;
  });
}
