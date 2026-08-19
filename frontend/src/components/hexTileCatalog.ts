// frontend/src/components/hexTileCatalog.ts
//
// PHASE 1 of the `HexGridRenderer.tsx` monolith extraction.
//
// WHAT THIS IS. The frontend's hand-kept mirror of `hexmap::TILE_CATALOG` --
// the 46-entry 1830 tile tray -- plus the types that describe an entry and
// the dev-only drift tripwires that guard the mirror. Everything here is
// DATA and pure lookups over it. No canvas, no React, no DOM.
//
// WHY THIS BOUNDARY FIRST. It is the largest genuinely self-contained unit in
// the file and the one with the fewest inbound edges: the catalog depends on
// nothing else in `HexGridRenderer.tsx`, while a great deal of that file
// depends on it. Extracting a leaf is the only extraction that cannot create
// a circular import, which makes it the right first cut and the reason this
// is Phase 1 rather than, say, the marker renderers (which need geometry,
// which needs constants, which is a three-way tangle to unpick at once).
//
// It is also the boundary that already proved itself: `TileGraphics.ts` was
// extracted on exactly this principle -- literal data plus pure functions
// over it -- and has needed no structural change since.
//
// WHAT DELIBERATELY DID NOT COME WITH IT. `terrainBaseValue` looks like it
// belongs here and does not: it is a rendering FALLBACK for a tile with no
// printed revenue, consumed only by the badge pass, and moving it would drag
// the badge vocabulary into a data module. It stays with the renderer until
// Phase 3 gives it a better home.
//
// IMPORT DIRECTION IS ONE-WAY, and must stay that way: this module must never
// import from `HexGridRenderer.tsx`. If something here ever appears to need
// something there, the dependency is pointing the wrong way and the thing it
// needs belongs in this file or in a module below it.

/** `BostonHub`/`NewYorkHub` (design note #49; mirrors `hexmap.rs` module doc
 *  comment #26/#27, `state::TerrainType::BostonHub`/`NewYorkHub` exactly):
 *  real 1830's "B"-labeled (Boston AND Baltimore) and "NY"-labeled hub
 *  artwork -- previously missing from this frontend mirror entirely (a
 *  cross-file consistency gap: the backend catalog had tiles 16/17 since
 *  module doc comment #26, but this file's own `TILE_CATALOG`/
 *  `TerrainType` never gained a matching entry, so a laid Boston/New York
 *  Green tile fell through every `TILE_CATALOG_BY_ID.get(...)` lookup below
 *  as `undefined` -- visibly wrong stroke color (`#c0392b`, the "unknown
 *  tile" fallback, instead of the real tier color) and a broken tile-picker
 *  thumbnail). Closed as part of this pass's own "Complete the Tile
 *  Manifest" scope. `BostonHub` renders like `MajorCityHub` (one station);
 *  `NewYorkHub` renders like `DoubleCityHub` (two stations) -- see
 *  `drawTrackPath`'s own dispatch below. */
export type TerrainType =
  | "Plain"
  | "MountainRugged"
  | "SmallTown"
  | "DoubleTown"
  | "MajorCityHub"
  | "DoubleCityHub"
  | "BostonHub"
  | "NewYorkHub";
export type TileColorTier = "Yellow" | "Green" | "Brown";

export interface TileCatalogEntry {
  tileId: number;
  /** Base (pre-rotation) 6-bit edge bitmask -- mirrors
   *  `hexmap::TILE_CATALOG`'s second tuple element exactly. */
  connections: number;
  terrain: TerrainType;
  color: TileColorTier;
  /** Design note #52 -- FRONTEND-ONLY, deliberately NOT mirrored from the
   *  backend (which doesn't need it: `pathfinding.rs`'s simplified
   *  hex-level revenue model never distinguishes which edge belongs to
   *  which city within one tile, only the flat `connections` union). For a
   *  genuine two-city tile (NY, every OO variant), each entry is the real
   *  per-city edge group (e.g. `[[0, 1], [2, 3]]` means city A owns edges
   *  0-1 and city B owns edges 2-3) -- `drawTrackPath` uses this so each
   *  city draws its own paired curve instead of fanning every live edge
   *  into one shared hub, which is wrong for a tile that actually has two
   *  independent city nodes. Omitted (`undefined`) for every single-city
   *  tile, which keeps the existing fan-to-center rendering unchanged. */
  /* ==================================================================
   *  DESIGN NOTE 626: THE COLUMN THE MIRROR LEFT BEHIND
   * ==================================================================
   *
   * How many physical copies of this artwork a room starts with -- the SIXTH
   * field of `hexmap::TILE_CATALOG`, taken from `tobymao/18xx`'s
   * `g_1830/map.rb` TILES hash exactly as `connections`, `paths` and
   * `revenue` above were.
   *
   * IT WAS ALWAYS ENFORCED AND NEVER SHOWN. `contract.rs` seeds a per-game
   * tray at these counts and `state::REMAINING_TILES` decrements as tiles are
   * laid, so scarcity is live state rather than trivia. This mirror simply
   * dropped the column, which left the UI unable to say why a lay was about
   * to be refused -- or that #57 is the ONLY yellow city tile in this
   * catalog, four copies against eight corporations needing a home.
   *
   * THE `UNLIMITED_TILE_SUPPLY` SENTINEL IS NOT MODELLED. `hexmap.rs`
   * defines `u32::MAX` for a tile exempt from tray limits and no current
   * entry uses it -- all 46 carry a real printed count, which
   * `tileSupply.test.ts` asserts. Representing an unlimited case nothing
   * produces would be a branch with no way to test it; if the backend ever
   * uses the sentinel, that test fails first and this is the note to read. */
  quantity: number;
  cityGroups?: readonly (readonly number[])[];
  /** Design note #119: this tile's DISCRETE track segments as BASE
   *  (pre-rotation) edge pairs, mirroring `hexmap::TILE_CATALOG`'s SEVENTH
   *  tuple element. Unlike `cityGroups` above, this one IS real backend
   *  data, not a frontend-only embellishment -- the Rust catalog has
   *  carried it since Audit G-9 and `pathfinding.rs` routes on it.
   *
   *  Each `[a, b]` is one continuous run of track between edges `a` and
   *  `b`; `a === b` would be a terminal spur (none of the tiles mirrored
   *  here have one). The union of every edge listed equals `connections`,
   *  which the Rust test
   *  `tile_catalog_paths_agree_with_connection_masks_for_all_forty_six_tiles`
   *  asserts for all 46 entries.
   *
   *  STALE SCOPE NOTE, CORRECTED. The paragraph below says this is
   *  "POPULATED ONLY FOR THE FIVE DOUBLETOWN TILES". That was true when it
   *  was written and is no longer: the mirror now carries `paths` for ALL
   *  46 entries. Counted rather than assumed -- the harness for the strict
   *  path-preservation pass walks the catalog and reports 46/46.
   *
   *  A CITY HUB APPEARS AS THE FULL PAIRWISE EXPANSION of its live edges:
   *  #14 (edges 0/1/3/4) lists all six pairs, #63 (all six edges) all
   *  fifteen. That is what lets a consumer ask "does edge 0 still reach
   *  edge 3" without having to reason about the city sitting between them,
   *  and it is why strict upgrade path-preservation can be a plain set
   *  comparison. The original scope reasoning is kept verbatim below for
   *  the record.
   *
   *  ORIGINALLY POPULATED ONLY FOR THE FIVE DOUBLETOWN TILES (#1, #2, #55,
   *  #56, #69), deliberately and by scope decision. Those are the tiles where the flat
   *  `connections` mask is genuinely lossy: four live edges paired into two
   *  independent two-edge routes, one per town, and the mask cannot say
   *  which edge pairs with which. Every other tile is either unambiguous
   *  from its mask or already handled correctly by an existing branch
   *  (`cityGroups` for two-city hubs, the 2-edge shortcut for simple
   *  curves/straights, the fan for multi-spur junctions), so mirroring
   *  paths for them would add a second source of truth for the same
   *  rendering with no visible change. `pathsForTile` returns `undefined`
   *  for those and every existing code path stays exactly as it was. */
  paths?: ReadonlyArray<readonly [number, number]>;
  /** Design note #135: this tile's OWN printed revenue, mirroring
   *  `hexmap::TILE_CATALOG`'s EIGHTH tuple element (`Option<u32>`, Audit
   *  G-11) exactly. `undefined` mirrors the backend's `None` and means "this
   *  tile has no printed figure, price it from its terrain bucket" -- which
   *  is true only of plain connector track.
   *
   *  WHY THIS EXISTS, since the board already reads revenue off the chain:
   *  the TILE PICKER does not. A tray thumbnail renders a tile that is not on
   *  the board yet, so there is no `MapTileEntry` to read and no chain
   *  round-trip to make -- and in offline mode there is no chain at all
   *  (`localCatalogPlacements` builds the whole tray from this array). Those
   *  paths fell through to `terrainBaseValue`, which is a flat per-terrain
   *  bucket and cannot express real 1830: the picker showed #62 as $40 (the
   *  `NewYorkHub` bucket) when the tile prints $90, and #61 as $20 when it
   *  prints $60. A player choosing between upgrades was reading numbers the
   *  contract would never pay.
   *
   *  Twelve of the twenty-two city/town tiles deviate from their bucket:
   *    #14/#15  bucket 20 -> 30      #53  bucket 20 -> 50
   *    #54      bucket 40 -> 60      #61  bucket 20 -> 60
   *    #62      bucket 40 -> 90      #63  bucket 20 -> 40
   *    #64-#68  bucket 40 -> 50
   *  The other ten (#1-#4, #55-#59, #69) happen to agree with their bucket
   *  today. They are mirrored ANYWAY, explicitly: "agrees with the bucket"
   *  is a coincidence of the current numbers, not a property, and leaving
   *  them implicit would mean the next backend revenue change silently
   *  reintroduces exactly this bug on whichever tile it touches.
   *
   *  PRECEDENCE, resolved in `drawTileOverlays`: the chain's
   *  `MapTileEntry.revenue` wins where there is one (a laid tile), then this,
   *  then `terrainBaseValue`. Never the other way round -- this is a mirror
   *  of the backend catalog, and the chain is the backend catalog. */
  revenue?: number;
}

/** Hand-kept mirror of `hexmap::TILE_CATALOG` (see design note #2 above).
 *  Keep this in exact sync with that Rust array -- same `tile_id`s, same
 *  bitmasks, same terrain/color tags -- any time it changes.
 *
 *  **Design note #118: 46-Tile Tray Catalog Sync (backend Audit G-5).** The
 *  backend catalog no longer uses this engine's old synthetic, sequential
 *  internal ids (1, 2, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
 *  20-24). It now keys every entry on the tile's REAL physical 1830 tray
 *  number and carries the complete 46-tile manifest. This mirror is
 *  rewritten wholesale to match, entry for entry.
 *
 *  What moved (old internal id -> real tray number):
 *    - Green "NY" hub      17 -> 54
 *    - Green "B" hub       16 -> 53
 *    - Green "OO" hub      15 -> 59
 *    - Brown "NY" hub      19 -> 62
 *    - Brown "B" hub       18 -> 61
 *    - Brown "OO" hubs  20-24 -> 64, 65, 66, 67, 68
 *    - Yellow city hub     10 -> 57
 *    - Brown city hub      14 -> 63   (and Green city hubs are now 14/15)
 *
 *  What was DELETED outright, with no replacement: the invented terrain
 *  artwork (old ids 4, 5, 12 -- "MountainRugged" tiles) and the invented
 *  green filler tiles (old ids 11, 13), plus the old id 6 double-town.
 *  Real 1830 charges terrain as a HEX property, not a tile property, so
 *  `hexmap::terrain_build_fee(q, r)` ($80 river / $120 mountain / $0 clear)
 *  is now the only terrain-cost source -- see `TERRAIN_BUILD_COST_LABEL`.
 *
 *  DANGER, and the reason this had to be a wholesale rewrite rather than a
 *  patch: the old and new id spaces OVERLAP with completely different
 *  meanings. Old internal 16/18/19/20/23/24 were "B"/"NY"/"OO" hub artwork;
 *  real tray #16/#18/#19/#20/#23/#24 are ordinary green PLAIN track. Had
 *  this mirror been left alone, those ids would still have resolved -- to
 *  silently, confidently wrong artwork (a plain green curve rendered as a
 *  two-station New York hub, and vice versa) rather than to the honest
 *  `undefined` placeholder path that a genuinely unknown id takes.
 *
 *  `MountainRugged` survives in `TerrainType`/`TERRAIN_FILL`/
 *  `terrainBaseValue` even though no entry below carries it any more --
 *  deliberately, mirroring the backend, which kept the `state::TerrainType`
 *  variant so already-stored `Tile` records still deserialize and so this
 *  frontend enum needs no lockstep change. See `hexmap::terrain_base_value`
 *  ("Audit G-5/G-10: NO tile carries this terrain any more"). */
export const TILE_CATALOG: readonly TileCatalogEntry[] = [

  /* ---- Yellow tier (12 tiles) ---- */
  {
    tileId: 1,
    connections: 0b011_011,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 4], [1, 3]],
    revenue: 10,
  },
  {
    tileId: 2,
    connections: 0b001_111,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 3], [1, 2]],
    revenue: 10,
  },
  {
    tileId: 3,
    connections: 0b000_011,
    terrain: "SmallTown",
    color: "Yellow",
    quantity: 2,
    paths: [[0, 1]],
    revenue: 10,
  },
  {
    tileId: 4,
    connections: 0b001_001,
    terrain: "SmallTown",
    color: "Yellow",
    quantity: 2,
    paths: [[0, 3]],
    revenue: 10,
  },
  {
    tileId: 7,
    connections: 0b000_011,
    terrain: "Plain",
    color: "Yellow",
    quantity: 4,
    paths: [[0, 1]],
  },
  {
    tileId: 8,
    connections: 0b000_101,
    terrain: "Plain",
    color: "Yellow",
    quantity: 8,
    paths: [[0, 2]],
  },
  {
    tileId: 9,
    connections: 0b001_001,
    terrain: "Plain",
    color: "Yellow",
    quantity: 7,
    paths: [[0, 3]],
  },
  {
    tileId: 55,
    connections: 0b011_011,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 3], [1, 4]],
    revenue: 10,
  },
  {
    tileId: 56,
    connections: 0b001_111,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 2], [1, 3]],
    revenue: 10,
  },
  {
    tileId: 57,
    connections: 0b001_001,
    terrain: "MajorCityHub",
    color: "Yellow",
    quantity: 4,
    paths: [[0, 3]],
    revenue: 20,
  },
  {
    tileId: 58,
    connections: 0b000_101,
    terrain: "SmallTown",
    color: "Yellow",
    quantity: 2,
    paths: [[0, 2]],
    revenue: 10,
  },
  {
    tileId: 69,
    connections: 0b011_101,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 3], [2, 4]],
    revenue: 10,
  },

  /* ---- Green tier (16 tiles) ---- */
  {
    tileId: 14,
    connections: 0b011_011,
    terrain: "MajorCityHub",
    color: "Green",
    quantity: 3,
    paths: [[0, 1], [0, 3], [0, 4], [1, 3], [1, 4], [3, 4]],
    revenue: 30,
  },
  {
    tileId: 15,
    connections: 0b001_111,
    terrain: "MajorCityHub",
    color: "Green",
    quantity: 2,
    paths: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
    revenue: 30,
  },
  {
    tileId: 16,
    connections: 0b001_111,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 2], [1, 3]],
  },
  {
    tileId: 18,
    connections: 0b001_111,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 3], [1, 2]],
  },
  {
    tileId: 19,
    connections: 0b011_101,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 3], [2, 4]],
  },
  {
    tileId: 20,
    connections: 0b011_011,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 3], [1, 4]],
  },
  {
    tileId: 23,
    connections: 0b011_001,
    terrain: "Plain",
    color: "Green",
    quantity: 3,
    paths: [[0, 3], [0, 4]],
  },
  {
    tileId: 24,
    connections: 0b001_101,
    terrain: "Plain",
    color: "Green",
    quantity: 3,
    paths: [[0, 2], [0, 3]],
  },
  {
    tileId: 25,
    connections: 0b010_101,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 2], [0, 4]],
  },
  {
    tileId: 26,
    connections: 0b101_001,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 3], [0, 5]],
  },
  {
    tileId: 27,
    connections: 0b001_011,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 1], [0, 3]],
  },
  {
    tileId: 28,
    connections: 0b110_001,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 4], [0, 5]],
  },
  {
    tileId: 29,
    connections: 0b000_111,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[0, 1], [0, 2]],
  },
  {
    tileId: 53,
    connections: 0b010_101,
    terrain: "BostonHub",
    color: "Green",
    quantity: 2,
    paths: [[0, 2], [0, 4], [2, 4]],
    revenue: 50,
  },
  {
    tileId: 54,
    connections: 0b001_111,
    terrain: "NewYorkHub",
    color: "Green",
    quantity: 1,
    cityGroups: [[0, 1], [2, 3]],
    paths: [[0, 1], [2, 3]],
    revenue: 60,
  },
  {
    tileId: 59,
    connections: 0b000_101,
    terrain: "DoubleCityHub",
    color: "Green",
    quantity: 2,
    cityGroups: [[0], [2]],
    paths: [[0, 0], [2, 2]],
    revenue: 40,
  },

  /* ---- Brown tier (18 tiles) ---- */
  {
    tileId: 39,
    connections: 0b000_111,
    terrain: "Plain",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 2], [1, 2]],
  },
  {
    tileId: 40,
    connections: 0b010_101,
    terrain: "Plain",
    color: "Brown",
    quantity: 1,
    paths: [[0, 2], [0, 4], [2, 4]],
  },
  {
    tileId: 41,
    connections: 0b001_011,
    terrain: "Plain",
    color: "Brown",
    quantity: 2,
    paths: [[0, 1], [0, 3], [1, 3]],
  },
  {
    tileId: 42,
    connections: 0b101_001,
    terrain: "Plain",
    color: "Brown",
    quantity: 2,
    paths: [[0, 3], [0, 5], [3, 5]],
  },
  {
    tileId: 43,
    connections: 0b001_111,
    terrain: "Plain",
    color: "Brown",
    quantity: 2,
    paths: [[0, 2], [0, 3], [1, 2], [1, 3]],
  },
  {
    tileId: 44,
    connections: 0b011_011,
    terrain: "Plain",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 3], [1, 4], [3, 4]],
  },
  {
    tileId: 45,
    connections: 0b011_101,
    terrain: "Plain",
    color: "Brown",
    quantity: 2,
    paths: [[0, 3], [0, 4], [2, 3], [2, 4]],
  },
  {
    tileId: 46,
    connections: 0b011_101,
    terrain: "Plain",
    color: "Brown",
    quantity: 2,
    paths: [[0, 2], [0, 3], [2, 4], [3, 4]],
  },
  {
    tileId: 47,
    connections: 0b011_011,
    terrain: "Plain",
    color: "Brown",
    quantity: 1,
    paths: [[0, 3], [0, 4], [1, 3], [1, 4]],
  },
  {
    tileId: 61,
    connections: 0b011_101,
    terrain: "BostonHub",
    color: "Brown",
    quantity: 2,
    paths: [[0, 2], [0, 3], [0, 4], [2, 3], [2, 4], [3, 4]],
    revenue: 60,
  },
  {
    tileId: 62,
    connections: 0b001_111,
    terrain: "NewYorkHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 1], [2, 3]],
    paths: [[0, 1], [2, 3]],
    revenue: 90,
  },
  {
    tileId: 63,
    connections: 0b111_111,
    terrain: "MajorCityHub",
    color: "Brown",
    quantity: 3,
    paths: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [2, 4], [2, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 40,
  },
  {
    tileId: 64,
    connections: 0b011_101,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 2], [3, 4]],
    paths: [[0, 2], [3, 4]],
    revenue: 50,
  },
  {
    tileId: 65,
    connections: 0b011_101,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 4], [2, 3]],
    paths: [[0, 4], [2, 3]],
    revenue: 50,
  },
  {
    tileId: 66,
    connections: 0b001_111,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 3], [1, 2]],
    paths: [[0, 3], [1, 2]],
    revenue: 50,
  },
  {
    tileId: 67,
    connections: 0b011_101,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 3], [2, 4]],
    paths: [[0, 3], [2, 4]],
    revenue: 50,
  },
  {
    tileId: 68,
    connections: 0b011_011,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 3], [1, 4]],
    paths: [[0, 3], [1, 4]],
    revenue: 50,
  },
  {
    tileId: 70,
    connections: 0b001_111,
    terrain: "Plain",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 2], [1, 3], [2, 3]],
  },
];

/** How many entries `hexmap::TILE_CATALOG` holds after Audit G-5's full
 *  1830 manifest expansion. Asserted against at module load (below) purely
 *  as a drift tripwire on this hand-kept mirror -- see design note #2 on why
 *  a mirror that silently falls behind is this file's standing hazard. */
export const TILE_CATALOG_SIZE = 46;

export const TILE_CATALOG_BY_ID: ReadonlyMap<number, TileCatalogEntry> = new Map(
  TILE_CATALOG.map((entry) => [entry.tileId, entry]),
);

// Drift tripwire (design note #118). A duplicated `tileId` would silently
// collapse inside the `Map` above and quietly shadow one of the two
// entries, which is exactly the class of bug the old/new id-space overlap
// makes easy to introduce. Dev-only: never throws, never runs in a
// production bundle.
if (process.env.NODE_ENV !== "production") {
  if (TILE_CATALOG.length !== TILE_CATALOG_SIZE || TILE_CATALOG_BY_ID.size !== TILE_CATALOG_SIZE) {
    // eslint-disable-next-line no-console
    console.warn(
      `[hexTileCatalog] TILE_CATALOG mirror drift: ${TILE_CATALOG.length} entries / ` +
        `${TILE_CATALOG_BY_ID.size} unique ids, expected ${TILE_CATALOG_SIZE}. ` +
        "Re-sync against hexmap::TILE_CATALOG.",
    );
  }

  // Design note #135: revenue drift tripwire. Every tile that draws a badge
  // -- anything with a town or a city -- must carry an explicit `revenue`
  // mirrored from the backend. A city/town entry WITHOUT one silently falls
  // through to `terrainBaseValue` in the picker and prints a number the
  // contract will not pay, which is precisely the bug this note fixes and is
  // invisible unless you happen to know the right figure by heart.
  const missingRevenue = TILE_CATALOG.filter(
    (entry) => entry.terrain !== "Plain" && entry.terrain !== "MountainRugged" && entry.revenue === undefined,
  ).map((entry) => entry.tileId);
  if (missingRevenue.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[hexTileCatalog] TILE_CATALOG revenue drift: tile(s) ${missingRevenue.join(", ")} ` +
        "carry a revenue centre but no explicit `revenue`. The tile picker will fall back to " +
        "terrainBaseValue and print a figure the contract will not pay. " +
        "Re-sync against hexmap::TILE_CATALOG's eighth tuple element.",
    );
  }

  // The double-town artwork/catalog cross-check lives further down, beside
  // `DOUBLE_TOWN_ROUTES` itself -- that table is a `const` declared after
  // this point, so it cannot be read here.
}
