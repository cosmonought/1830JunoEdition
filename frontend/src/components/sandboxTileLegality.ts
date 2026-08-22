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
import { IMPASSABLE_BORDER_EDGES, LANDMARK_HEXES, STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "./hexBoardData";
import {
  HEX_NEIGHBOR_OFFSETS,
  archetypeForHex,
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
import { portKey } from "../utils/trackReach";

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
export type HexLabelRestriction = "OO" | "B" | "NY";

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

/* Design note #3: A PREPRINTED HEX IS ALREADY AT A TIER. The labelled hexes carry `printedColor: "Yellow"` --
   the board ships with their yellow tile already on it -- but a preprint is not a `MapTileEntry`, so the tile
   grid has no row for them and a naive read sees them as bare ground.
   They are RANK 0, which has two consequences, both requirements rather than conveniences: their first legal
   upgrade is GREEN, because a yellow tile cannot be laid on a hex that already has one; and a BROWN tile is
   not offered until a green one is down -- without the rank, a Brown-era game would have offered brown
   straight onto a still-yellow New York, which is `InvalidColorUpgrade` on chain. */
const PREPRINTED_TIER_BY_LABEL: ReadonlyMap<string, TileColorTier> = new Map(
  STATIC_BOARD_HEXES.flatMap((hex) =>
    hex.printedColor === "Yellow" ? ([[hex.label, "Yellow"]] as [string, TileColorTier][]) : [],
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

    // 4b. Design note #7: no rail pointing off the edge of the board.
    if (!staysOnBoard(q, r, entry, orientation)) return false;

    /* 4c. Design note #756: and none pointing into one of the four impassable borders. Beside #7 rather than
       folded into it, because the two rules answer different questions -- "is there a hex there" and "may
       track cross into it" -- and a hex on the far side of a barrier is perfectly real. */
    if (crossesImpassableBorder(q, r, entry, orientation)) return false;

    // 5. Path preservation, per orientation.
    if (existing && !preservesRouting(existing, laid?.orientation ?? 0, entry, orientation)) {
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
