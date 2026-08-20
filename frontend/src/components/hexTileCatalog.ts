// frontend/src/components/hexTileCatalog.ts
//
// PHASE 1 of the `HexGridRenderer.tsx` monolith extraction: the frontend's hand-kept mirror of
// `hexmap::TILE_CATALOG` -- the 46-entry 1830 tile tray -- plus the types describing an entry and the dev-only
// drift tripwires that guard the mirror. Everything here is DATA and pure lookups over it.
//
// WHY THIS BOUNDARY FIRST: it is the largest genuinely self-contained unit in the file and the one with the
// fewest inbound edges. Extracting a leaf is the only extraction that cannot create a circular import -- unlike
// the marker renderers, which need geometry, which needs constants, a three-way tangle to unpick at once.
// It is also the boundary that already proved itself: `TileGraphics.ts` was extracted on exactly this
// principle and has needed no structural change since.
//
// WHAT DELIBERATELY DID NOT COME WITH IT: `terrainBaseValue` looks like it belongs and does not -- it is a
// rendering FALLBACK consumed only by the badge pass, and moving it would drag the badge vocabulary into a
// data module.
//
// IMPORT DIRECTION IS ONE-WAY: never import from `HexGridRenderer.tsx`.
//
// Design notes #49/#52/#118/#119/#135/#626: see `docs/ai_architecture/hex_tile_math.md`.

/** Design note #49: the "B"/"NY" hub artwork, previously missing from this mirror entirely -- a cross-file
 *  consistency gap. The backend catalog had tiles 16/17 since its module doc #26 and this file never gained a
 *  matching entry, so a laid Boston/New York Green tile fell through every lookup as `undefined`: visibly wrong
 *  stroke colour (the "unknown tile" fallback rather than the real tier colour) and a broken picker thumbnail.
 *  `BostonHub` renders like a single-station hub; `NewYorkHub` like a two-station one. */
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
  /** Design note #52: FRONTEND-ONLY, deliberately not mirrored -- the backend does not need it, since its
   *  hex-level revenue model never distinguishes which edge belongs to which city within one tile. For a genuine
   *  two-city tile each entry is the real per-city edge group, so each city draws its own paired curve instead of
   *  fanning every live edge into one shared hub. Omitted for every single-city tile.
   *  Design note #626: THE COLUMN THE MIRROR LEFT BEHIND -- how many physical copies of this artwork a room starts
   *  with, the sixth field of the Rust catalog, taken from `g_1830/map.rb`'s TILES hash exactly as the others were.
   *  IT WAS ALWAYS ENFORCED AND NEVER SHOWN: `contract.rs` seeds a per-game tray at these counts and
   *  `REMAINING_TILES` decrements as tiles are laid, so scarcity is live state rather than trivia. This mirror
   *  dropped the column, which left the UI unable to say why a lay was about to be refused -- or that #57 is the
   *  ONLY yellow city tile in this catalog, four copies against eight corporations needing a home.
   *  THE `UNLIMITED_TILE_SUPPLY` SENTINEL IS NOT MODELLED: no current entry uses it, and representing an unlimited
   *  case nothing produces would be a branch with no way to test it. If the backend ever uses it, the supply test
   *  fails first and this is the note to read. */
  quantity: number;
  cityGroups?: readonly (readonly number[])[];
  /** Design note #119: this tile's DISCRETE track segments as BASE (pre-rotation) edge pairs, mirroring the
   *  seventh tuple element. Unlike `cityGroups`, this IS real backend data -- the Rust catalog has carried it
   *  since Audit G-9 and `pathfinding.rs` routes on it. The union of every edge listed equals `connections`, which
   *  a Rust test asserts for all 46 entries.
   *  STALE SCOPE NOTE, CORRECTED: the original text said this was populated only for the five doubletown tiles.
   *  True when written, no longer -- the mirror carries `paths` for ALL 46, counted rather than assumed.
   *  A CITY HUB APPEARS AS THE FULL PAIRWISE EXPANSION of its live edges: #14 lists all six pairs, #63 all
   *  fifteen. That is what lets a consumer ask "does edge 0 still reach edge 3" without reasoning about the city
   *  between them, and it is why strict upgrade path-preservation can be a plain set comparison.
   *  (The original scope reasoning: the doubletown tiles are where the flat mask is genuinely lossy -- four live
   *  edges paired into two independent two-edge routes, one per town, and the mask cannot say which pairs with
   *  which.) */
  paths?: ReadonlyArray<readonly [number, number]>;
  /** Design note #135: this tile's OWN printed revenue, mirroring the eighth tuple element exactly. `undefined`
   *  mirrors the backend's `None` and means "price it from its terrain bucket", which is true only of plain track.
   *  WHY THIS EXISTS, since the board already reads revenue off the chain: the TILE PICKER does not. A tray
   *  thumbnail renders a tile that is not on the board yet, so there is no `MapTileEntry` to read -- and offline
   *  there is no chain at all. Those paths fell through to the flat bucket, which cannot express real 1830: the
   *  picker showed #62 as $40 when the tile prints $90, and #61 as $20 when it prints $60. A player choosing
   *  between upgrades was reading numbers the contract would never pay.
   *  Twelve of the twenty-two city/town tiles deviate from their bucket (#14/#15 20->30, #53 20->50, #54 40->60,
   *  #61 20->60, #62 40->90, #63 20->40, #64-#68 40->50). The other ten are mirrored ANYWAY: "agrees with the
   *  bucket" is a coincidence of the current numbers, not a property, and leaving them implicit would mean the
   *  next backend revenue change silently reintroduces this bug on whichever tile it touches.
   *  PRECEDENCE: the chain's `MapTileEntry.revenue` wins where there is one, then this, then the bucket. Never the
   *  other way round -- this is a mirror of the backend catalog, and the chain is the backend catalog. */
  revenue?: number;
}

/** Hand-kept mirror of `hexmap::TILE_CATALOG` -- keep this in exact sync with that Rust array any time it
 *  changes.
 *  Design note #118: 46-TILE TRAY CATALOG SYNC (Audit G-5). The backend no longer uses this engine's old
 *  synthetic sequential ids; it keys every entry on the tile's REAL physical 1830 tray number. What moved:
 *  Green NY 17->54, Green B 16->53, Green OO 15->59, Brown NY 19->62, Brown B 18->61, Brown OO 20-24->64-68,
 *  Yellow city 10->57, Brown city 14->63.
 *  DELETED OUTRIGHT, with no replacement: the invented terrain artwork (old 4, 5, 12) and green fillers (11,
 *  13), plus old 6. Real 1830 charges terrain as a HEX property, not a tile property, so
 *  `hexmap::terrain_build_fee` is now the only terrain-cost source.
 *  DANGER, and the reason this had to be a wholesale rewrite rather than a patch: the old and new id spaces
 *  OVERLAP with completely different meanings. Old internal 16/18/19/20/23/24 were hub artwork; real tray
 *  #16/#18/#19/#20/#23/#24 are ordinary green PLAIN track. Left alone, those ids would still have resolved -- to
 *  silently, confidently wrong artwork rather than to the honest `undefined` placeholder an unknown id takes.
 *  `MountainRugged` survives in the terrain enum even though no entry carries it, deliberately, mirroring the
 *  backend: the variant was kept so already-stored `Tile` records still deserialize. */
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

// Drift tripwire (design note #118). A duplicated `tileId` would silently collapse inside the `Map` above and
// quietly shadow one of the two entries, which is exactly the class of bug the old/new id-space overlap makes
// easy to introduce. Dev-only: never throws, never runs in a production bundle.
if (process.env.NODE_ENV !== "production") {
  if (TILE_CATALOG.length !== TILE_CATALOG_SIZE || TILE_CATALOG_BY_ID.size !== TILE_CATALOG_SIZE) {
    // eslint-disable-next-line no-console
    console.warn(
      `[hexTileCatalog] TILE_CATALOG mirror drift: ${TILE_CATALOG.length} entries / ` +
        `${TILE_CATALOG_BY_ID.size} unique ids, expected ${TILE_CATALOG_SIZE}. ` +
        "Re-sync against hexmap::TILE_CATALOG.",
    );
  }

  // Design note #135: revenue drift tripwire. Every tile that draws a badge -- anything with a town or a city --
  // must carry an explicit `revenue` mirrored from the backend. A city/town entry WITHOUT one silently falls
  // through to `terrainBaseValue` in the picker and prints a number the contract will not pay, which is invisible
  // unless you happen to know the right figure by heart.
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
