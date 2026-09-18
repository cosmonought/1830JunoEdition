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
  | "NewYorkHub"
  /** Design note #1317: the Project 18XX+ set's Toronto tiles (#810, #882) -- two cities, a "TO" letter code,
   *  legal only on the hex printed TO (D10 on the expanded board). */
  | "TorontoHub";
/** Design note #1312: `Gray` is the Project 18XX+ tile set's fourth tier, reached with the first D-train
 *  under that variant only. The standard game never sees a Gray tile: none is in its tray (`tileTray.ts`)
 *  and its Diesel era stays Brown (`ERA_FOR_TIER`, sandboxSession.ts). */
export type TileColorTier = "Yellow" | "Green" | "Brown" | "Gray";

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
  /** Design note #1311: in the Project 18XX+ tray only. `quantity` is then that tray's count; the standard
   *  tray (`STANDARD_TRAY`) leaves the tile out entirely. */
  plusOnly?: true;
  /** Design note #1403: a one-town green that stands for TWO yellow towns joined -- #87, #88, #204 -- and so
   *  is laid only over a two-town hex. The three-exit green towns (#141-#144) carry no flag and take a
   *  one-town hex only; the legality filter reads this to keep the two families apart. */
  mergesTowns?: true;

  /* ==================================================================
      DESIGN NOTE 1628 (Slice 9.3, S9-19): TWO SYSTEMS THAT MAY NEVER MEET
     ==================================================================
     A RULE FACT, not a topology fact, and the only reason it is a per-tile flag is that the PRINTED RULE is
     per-tile. Revised 6.2.2 ❹, verbatim: "When a tile is replaced, all stations on the replaced tile must be
     placed on the new tile with the same connections as before. This also means that the pre-printed exits on
     a (59) tile can never be connected in the tile upgrade."

     WHAT IT MEANS HERE: this tile's `cityGroups` are not merely "which edge draws with which circle" -- they
     are SYSTEMS, and an upgrade laid over this tile may not put any two of them in one connected component of
     the new tile. The legality filter reads the flag and nothing else about the tile's number; a tile id never
     appears in the predicate (design note #1 forbids it), and the reducer consumes the metadata rather than a
     coordinate/facing blacklist.

     WHAT IT IS NOT, and this is the half that matters. It is NOT "merges are illegal". Stage 9.1 measured the
     legal merge family: the printed New York landmark is two revenue centres with no track between them and the
     green #54 that replaces it CONNECTS them legally (design note #676 and `priorTopologyAt`'s landmark arm say
     so), #53's and #592's Baltimore chain changes topology legally, and the town-merge family (#1403) exists
     precisely to join two centres into one. A global "source components may never merge" rule, or "city count
     must stay constant", would refuse every one of those. Only a tile carrying this flag is constrained, and
     today exactly one does: old #59. */
  separateSystems?: true;
  /* ==================================================================
      DESIGN NOTE 1630 (Slice 9.3, S9-21): THE NUMBER IS A KEY, NOT A NAME
     ==================================================================
     THE INVARIANT: an errata-invalid old number may remain a stable MACHINE KEY for compatibility, and is no
     longer treated as a canonical RULES IDENTITY. Two jobs, and 9.3 separates them rather than replacing one
     with the other.

     `tileId` above stays the STORAGE / ABI KEY for every tile, including the three below. It is what
     `ExecuteMsg::LayTile` carries as an int, what every stored log holds, what `MapTileEntry.tile_id` is, and
     what a golden's digest is built out of -- and it is written by NEW state too, so it is emphatically not an
     "input-only" spelling. Renumbering it would change the recorded shape of persisted state for no rules
     gain, and for two of the three there is no number to renumber TO.

     `canonicalId` is what the RULES call this tile after the official errata, and equally what a player should
     be shown. It is present ONLY where the printed old number is erroneous -- three entries -- and `undefined`
     everywhere else, where the printed old number is both the key and the name and the errata touches neither.
     Read it through `canonicalTileName(tileId)` at the bottom of this file rather than reaching for the field,
     so the fallback lives in one place.

     THE ERRATA VOIDS NUMBERS, NOT TILES. oo1, oo13 and oo14 are all valid, correct, playable tiles whose
     geometry and revenue are owner-confirmed. What the errata voids is their PRINTED OLD-SYSTEM NUMBERS:
     #626 is corrected to #8861, and #36 / #35 are withdrawn with no replacement, so for oo13 and oo14 the
     Lookout identifier is the only valid name there is. */
  canonicalId?: string;
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
    /* #1628 (S9-19): the two `cityGroups` above are the two pre-printed systems revised 6.2.2 ❹ names, and an
       upgrade may never connect them. The `paths` self-loops say the same thing from the other side -- each
       exit runs in and stops, with no track between the two cities. */
    separateSystems: true,
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

  /* ---- Project 18XX+ tile set (design note #1311). Edges are the board's own numbering, translated from
     the request's (0 NE, clockwise) by `edge()` in hexBoardDataPlus.ts: code = (1 - spec) mod 6. ---- */

  /* ---- Yellow ---- */
  {
    tileId: 6,
    connections: 0b100_010,
    terrain: "MajorCityHub",
    color: "Yellow",
    quantity: 2,
    paths: [[1, 5]],
    revenue: 20,
    plusOnly: true,
  },
  {
    tileId: 5,
    connections: 0b000_011,
    terrain: "MajorCityHub",
    color: "Yellow",
    quantity: 2,
    paths: [[0, 1]],
    revenue: 20,
    plusOnly: true,
  },
  {
    tileId: 630,
    /* #1392: RULED "630 has one small town with continuous track connecting edges 5 and 0 (tight curve) and
       a separate small town with continuous track connecting edges 1 and 3" -- in the request's own edge
       numbers (`edge()` translates). This is exactly 631's reflection (#1392a), so the pair is finally a pair. */
    connections: 0b010_111,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[1, 2], [0, 4]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 631,
    /* #1392: REPORTED "Tiles 630 and 631 are the same tile, but they're supposed to be reflections of each
       other." RULED: 630 is (5,0) tight + (1,3); 631 is (4,5) tight + (1,3) -- request numbers.
       #1392a: THIS ENTRY IS UNCHANGED FROM BEFORE THE RULING, AND MUST STAY SO. A live game (JUNO-Z6C, index
       447) had already laid a 631 with orientation 4 against this base; the first draft of #1392 rewrote the
       base to the ruling's own numbers and the laid tile turned on every board after the rebuild -- "a tile
       nobody placed". The ruled 631 is this shape turned two edges, so the base is kept and the ruling is
       met by making 630 THIS tile's reflection instead. */
    connections: 0b010_111,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[0, 1], [2, 4]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 632,
    connections: 0b111_100,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[2, 3], [4, 5]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 633,
    connections: 0b101_101,
    terrain: "DoubleTown",
    color: "Yellow",
    quantity: 1,
    paths: [[2, 3], [0, 5]],
    revenue: 10,
    plusOnly: true,
  },
  /* ---- Green ---- */
  {
    tileId: 592,
    connections: 0b010_101,
    terrain: "BostonHub",
    color: "Green",
    quantity: 2,
    paths: [[0, 2], [0, 4], [2, 4]],
    revenue: 50,
    plusOnly: true,
  },
  {
    tileId: 17,
    connections: 0b110_110,
    terrain: "Plain",
    color: "Green",
    quantity: 1,
    paths: [[1, 5], [2, 4]],
    plusOnly: true,
  },
  {
    tileId: 141,
    connections: 0b011_010,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[1, 3], [1, 4], [3, 4]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 142,
    connections: 0b110_010,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[1, 4], [1, 5], [4, 5]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 143,
    connections: 0b100_011,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[0, 1], [0, 5], [1, 5]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 144,
    connections: 0b101_010,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[1, 3], [1, 5], [3, 5]],
    revenue: 10,
    plusOnly: true,
  },
  {
    tileId: 88,
    connections: 0b011_011,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[0, 1], [0, 3], [0, 4], [1, 3], [1, 4], [3, 4]],
    revenue: 10,
    plusOnly: true,
    mergesTowns: true, // #1403
  },
  {
    tileId: 204,
    connections: 0b111_010,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[1, 3], [1, 4], [1, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 10,
    plusOnly: true,
    mergesTowns: true, // #1403
  },
  {
    tileId: 87,
    connections: 0b110_011,
    terrain: "SmallTown",
    color: "Green",
    quantity: 1,
    paths: [[0, 1], [0, 4], [0, 5], [1, 4], [1, 5], [4, 5]],
    revenue: 10,
    plusOnly: true,
    mergesTowns: true, // #1403
  },
  {
    tileId: 619,
    connections: 0b111_010,
    terrain: "MajorCityHub",
    color: "Green",
    quantity: 1,
    paths: [[1, 3], [1, 4], [1, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 30,
    plusOnly: true,
  },
  /* #1630 (S9-21): CANONICAL IDENTITY IS `#8861`, NOT `#626`. The official errata voids the printed 626 and
     names the correction; `canonicalId` below is the record, and `626` survives here as the STORAGE KEY -- the
     int the wire, the logs and the goldens already hold -- not as the tile's name.
     AND IT HAS NO SUCCESSOR, ON PURPOSE. Errata: "The oo1 (8861) tile is not upgradable"; owner ruling #1390
     says the same from the playtest side ("there's no upgrade for 626, it stops at Green"). Its two cities'
     exits ({0,1} and {3,4}) match no brown OO, so the derived graph reports the dead end by MEASURING it --
     there is no successor list here to delete and none to add. Filed, withdrawn and re-checked twice; this
     comment exists so it is not filed a third time. */
  {
    tileId: 626,
    /* #1630: STORAGE KEY 626, canonical rules/display identity `#8861`. See the field's note above. */
    canonicalId: "#8861",
    connections: 0b011_011,
    terrain: "DoubleCityHub",
    color: "Green",
    quantity: 1,
    cityGroups: [[0, 1], [3, 4]],
    paths: [[0, 1], [3, 4]],
    revenue: 40,
    plusOnly: true,
  },
  /* ---- Brown ---- */
  {
    tileId: 884,
    connections: 0b111_010,
    terrain: "BostonHub", // #1385: a brown B, beside 61
    color: "Brown",
    quantity: 1,
    paths: [[1, 3], [1, 4], [1, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 60, // #1398: "The revenue value on the B brown tiles is wrong. They're $60, not $40." -- the same $60 as #61.
    plusOnly: true,
  },
  {
    tileId: 997,
    connections: 0b111_010,
    terrain: "BostonHub", // #1385: a brown B, beside 61
    color: "Brown",
    quantity: 1,
    paths: [[1, 3], [1, 4], [1, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 60, // #1398: "The revenue value on the B brown tiles is wrong. They're $60, not $40." -- the same $60 as #61.
    plusOnly: true,
  },
  {
    tileId: 883,
    connections: 0b110_011,
    terrain: "NewYorkHub",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 4], [0, 5], [1, 4], [1, 5], [4, 5]],
    revenue: 90,
    plusOnly: true,
  },
  {
    tileId: 145,
    connections: 0b011_011,
    terrain: "SmallTown",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 3], [0, 4], [1, 3], [1, 4], [3, 4]],
    revenue: 20,
    plusOnly: true,
  },
  {
    tileId: 147,
    // #1403: swapped with #146 -- the upgrade chart has 204 -> 147 and 87 -> 146, so 147 carries 204's edges.
    connections: 0b111_010,
    terrain: "SmallTown",
    color: "Brown",
    quantity: 1,
    paths: [[1, 3], [1, 4], [1, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 20,
    plusOnly: true,
  },
  {
    tileId: 146,
    // #1403: swapped with #147 -- 146 carries 87's edges, being 87's brown.
    connections: 0b110_011,
    terrain: "SmallTown",
    color: "Brown",
    quantity: 1,
    paths: [[0, 1], [0, 4], [0, 5], [1, 4], [1, 5], [4, 5]],
    revenue: 20,
    plusOnly: true,
  },
  /* #1630 (S9-21): CANONICAL IDENTITY IS `oo13`. The errata voids the printed 36 and supplies no replacement
     ("should have a number that is NOT 36 -- neither support site has a number for this tile"), so the Lookout
     ID is the name and `36` is the storage key only. Geometry and revenue are owner-confirmed correct (two
     gap-2 cities at separation 3; $50). `oo13 -> oo20` having no legal facing is S9-16, a recorded
     contradiction between official sources, NOT a defect here -- do not "fix" this tile to close it. */
  {
    tileId: 36,
    /* #1630: STORAGE KEY 36, canonical rules/display identity `oo13`. See the field's note above. */
    canonicalId: "oo13",
    connections: 0b110_110,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[1, 5], [2, 4]],
    paths: [[1, 5], [2, 4]],
    revenue: 50,
    plusOnly: true,
  },
  /* #1630 (S9-21): CANONICAL IDENTITY IS `oo14`. Same errata clause as oo13 -- the printed 35 is void with no
     replacement, so `35` is the storage key and `oo14` is the name. Geometry and revenue owner-confirmed (two
     gap-2 cities at separation 1; $50), and `oo14 -> oo20` has six legal facings, which is why S9-16 names
     only its sibling. */
  {
    tileId: 35,
    /* #1630: STORAGE KEY 35, canonical rules/display identity `oo14`. See the field's note above. */
    canonicalId: "oo14",
    connections: 0b110_011,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[1, 5], [0, 4]],
    paths: [[1, 5], [0, 4]],
    revenue: 50,
    plusOnly: true,
  },
  {
    tileId: 984,
    connections: 0b110_011,
    terrain: "DoubleCityHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 1], [4, 5]],
    paths: [[0, 1], [4, 5]],
    revenue: 50,
    plusOnly: true,
  },
  /* ---- Toronto (design note #1317): a single- and a double-station city on #810, two doubles on #882 ---- */
  {
    tileId: 810,
    connections: 0b111_111,
    terrain: "TorontoHub",
    color: "Green",
    quantity: 1,
    cityGroups: [[0, 1, 5], [2, 3, 4]],
    paths: [[0, 1], [0, 5], [1, 5], [2, 3], [2, 4], [3, 4]],
    revenue: 50,
    plusOnly: true,
  },
  {
    tileId: 882,
    connections: 0b111_111,
    terrain: "TorontoHub",
    color: "Brown",
    quantity: 1,
    cityGroups: [[0, 1, 5], [2, 3, 4]],
    paths: [[0, 1], [0, 5], [1, 5], [2, 3], [2, 4], [3, 4]],
    revenue: 70,
    plusOnly: true,
  },
  /* ---- Gray (design note #1312) ---- */
  {
    tileId: 167,
    connections: 0b111_111,
    terrain: "DoubleCityHub",
    color: "Gray",
    quantity: 1,
    cityGroups: [[0, 1, 4], [2, 3, 5]],
    paths: [[0, 1], [0, 4], [1, 4], [2, 3], [2, 5], [3, 5]],
    revenue: 70,
    plusOnly: true,
  },
  {
    tileId: 513,
    connections: 0b111_111,
    terrain: "MajorCityHub",
    color: "Gray",
    quantity: 1,
    paths: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [2, 4], [2, 5], [3, 4], [3, 5], [4, 5]],
    revenue: 60,
    plusOnly: true,
  },
];

/** How many entries `hexmap::TILE_CATALOG` holds after Audit G-5's full
 *  1830 manifest expansion. Asserted against at module load (below) purely
 *  as a drift tripwire on this hand-kept mirror -- see design note #2 on why
 *  a mirror that silently falls behind is this file's standing hazard. */
/** 46 standard tiles and the 30 of the Project 18XX+ tile set (#1311, #1317). */
export const TILE_CATALOG_SIZE = 76;

export const TILE_CATALOG_BY_ID: ReadonlyMap<number, TileCatalogEntry> = new Map(
  TILE_CATALOG.map((entry) => [entry.tileId, entry]),
);

/** What the rules call this tile, and what a player should be shown for it -- design note #1630.
 *
 *  THE ONE NAMING AUTHORITY, on the live catalog rather than beside it. Every production path already resolves
 *  a serialized `tile_id` through `TILE_CATALOG_BY_ID`, so the canonical identity is in hand wherever the tile
 *  is; a second module holding the same fact would be a second authority to drift from.
 *
 *  Falls through to `#<id>` for the other 73 tiles, which is correct rather than a default: their printed old
 *  number IS their name, the errata touches neither, and the string they produce is byte-identical to the one
 *  every call site built by hand before this existed. Only oo1, oo13 and oo14 change, and only in what they
 *  are CALLED -- never in what is stored, sent or replayed. */
export function canonicalTileName(tileId: number): string {
  return TILE_CATALOG_BY_ID.get(tileId)?.canonicalId ?? `#${tileId}`;
}

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
