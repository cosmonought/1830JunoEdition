//! Hexagonal Grid Map Engine: floated public corporations lay track tiles onto
//! a single shared hex map (`rules.md` section 3, Step 1).
//!
//! `(q, r)` are axial coordinates; edge `i` at `(q, r)` touches edge
//! `(i + 3) % 6` of the neighbour at `(q, r) + HEX_NEIGHBOR_OFFSETS[i]`.
//!
//! The placement gates, in the order `execute_lay_tile` applies them -- each is
//! disjoint from the rest, and the absolute whole-hex ones come first:
//!
//!   Off-board       `OFFBOARD_HEXES`, the seven red terminals. No tile, ever.
//!   Gray immutable  `GRAY_PREPRINTED_HEXES`, twelve hexes of permanent
//!                   printed track. No tile, ever.
//!   Impassable edge `IMPASSABLE_HEX_EDGES`, four borders. Per-EDGE, not
//!                   per-hex: the hex stays buildable.
//!   Private reserve `PRIVATE_RESERVED_HEXES`, B20 and F16, until the linked
//!                   private is corporation-owned or closed.
//!   City / Town     `LANDMARK_HEXES`, `CITY_DESIGNATED_HEXES`,
//!                   `OO_DESIGNATED_HEXES`, `TOWN_DESIGNATED_HEXES`. Symmetric
//!                   in both directions: a reserved hex takes only its
//!                   designated artwork, and that artwork goes nowhere else.
//!   Era lock        the tile's `TileColor` against `current_global_era`.
//!   Connectivity    an unbroken live path back to the Token Station, OR
//!                   topology-retention if this is an upgrade.
//!
//! Blank plain/mountain/river hexes accept only plain track -- that falls out
//! of the symmetric City/Town gates rather than needing a rule of its own.
//!
//! `orientation` is player-chosen and validated, never auto-picked: exactly the
//! submitted rotation is evaluated, and rejected even if another would be
//! legal. A protocol's first tile ever is accepted at any orientation.
//!
//! Terrain cost is a property of the HEX (`terrain_build_fee`: $80 river, $120
//! mountain), charged once on the first lay; upgrades are free.
//!
//! Full design history -- all thirty module notes, the audit rebuilds, the
//! corrections that reversed each other, and the F16 divergence from the
//! frontend -- is in docs/ai_architecture/rust_contract_architecture.md.

//! Audit G-5/G-10: `TILE_CATALOG` holds the complete physical 1830 tile set --
//! 46 artworks, 85 copies -- keyed by REAL printed tray numbers. It previously
//! held 21 entries under an invented numbering that COLLIDED with real tray
//! numbers while meaning something else, so `GetLegalTilePlacements` handed a
//! player "tile 16" for what the physical game calls #53. Five invented tiles
//! were deleted rather than renumbered; terrain moved onto the hex.

//! Audit G-9: `TILE_CATALOG`'s seventh field is each tile's real internal
//! wiring as edge-to-edge segments. The flat mask alone is not enough to route
//! on -- real tile #1 is two INDEPENDENT towns, and a mask cannot tell that
//! from a four-way junction, so a train could cross track that does not exist.
//!
//! Nothing about tile LAYING changed: all 46 derived masks matched the
//! hand-entered ones exactly, so no placement's legality moved.

use cosmwasm_std::{DepsMut, Env, MessageInfo, Response, StdError, StdResult, Storage, Uint128};
use std::collections::{HashSet, VecDeque};
use thiserror::Error;

use crate::or_phase;
use crate::public_company::CORE_PUBLIC_COMPANIES;
use crate::state::{
    GameSession, OperatingSubPhase, PrivateCompany, PublicCompany, TerrainType, Tile, TileColor,
    HEX_STATION_TOKENS,
    MAP_GRID, PRIVATE_COMPANIES, PROTOCOL_LAST_TOKEN_SUBROUND, PROTOCOL_NETWORK_HEXES,
    PROTOCOL_PRESIDENT, PROTOCOL_STATION_HEXES, PUBLIC_COMPANIES, REMAINING_TILES, SESSIONS,
};

/// Sentinel `quantity` marking a `TILE_CATALOG` entry as exempt from the Tile
/// Inventory Supply Engine (Audit G-5): never decremented, never recycled,
/// never reported as depleted.
///
/// HISTORICAL: carried by the five invented tiles that had no real 1830 tray
/// tile to be faithful to. Audit G-5/G-10 (module doc comment #29) deleted all
/// five, so nothing carries this today.
pub const UNLIMITED_TILE_SUPPLY: u32 = u32::MAX;

/// `(tile_id, connection bitmask, terrain cost, terrain classification, colour
/// tier, starting tray quantity, base edge-to-edge paths, printed revenue)`.
///
/// Field 7 (Audit G-9) is the tile's real internal wiring:
///
///   `(a, b)`, a != b   a THROUGH segment, traversable either way.
///   `(a, a)`           a TERMINAL SPUR into a revenue centre with no second
///                      exit. Enter and END there; never pass through. Carried
///                      only by yellow "OO" #59, whose two cities are
///                      genuinely separate stubs -- which a mask cannot
///                      express at all.
///
/// Every pair is stored once in `(min, max)` order, so a segment claimed
/// travelling `a -> b` is the same ledger entry as one claimed `b -> a`.
///
/// Field 2 is exactly the union of field 7's edges, and is retained because it
/// -- not the path list -- is what placement, `impassable_edge_mask` and the
/// frontend renderer read. `tile_paths_and_connections_agree_for_every_catalog_entry`
/// pins the invariant.
///
/// Field 8 (Audit G-11) is the tile's OWN printed revenue, or `None` to fall
/// back to `terrain_base_value`'s flat bucket. Resolved in `tile_base_value`.
///
/// Sourcing, the encoding rules and the per-entry source strings are in
/// docs/ai_architecture/rust_contract_architecture.md (hexmap.rs #29/#30).
///
/// (Stated on the constant rather than inline: a tuple's fields cannot carry
/// `///` doc comments -- attaching one inside the type is a hard compile error,
/// `expected type, found doc comment`.)
pub const TILE_CATALOG: &[(
    u32,
    u8,
    u128,
    TerrainType,
    TileColor,
    u32,
    &[(u8, u8)],
    Option<u32>,
)] = &[
    // ---- Yellow tier: legal from every room's genesis. ----
    // #1 x1 -- two towns, edges 0/1/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:1,b:_0;path=a:_0,b:3;path=a:0,b:_1;path=a:_1,b:4`
    (1, 0b01_1011, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 4), (1, 3)], Some(10)),
    // #2 x1 -- two towns, edges 0/1/2/3.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:2`
    (2, 0b00_1111, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (1, 2)], Some(10)),
    // #3 x2 -- single town, sharp curve.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:1`
    (3, 0b00_0011, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 1)], Some(10)),
    // #4 x2 -- single town, straight.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:3`
    (4, 0b00_1001, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 3)], Some(10)),
    // #7 x4 -- plain sharp curve.
    // 18xx: `path=a:0,b:1`
    (7, 0b00_0011, 0, TerrainType::Plain, TileColor::Yellow, 4, &[(0, 1)], None),
    // #8 x8 -- plain gentle curve -- the most common tile in the game.
    // 18xx: `path=a:0,b:2`
    (8, 0b00_0101, 0, TerrainType::Plain, TileColor::Yellow, 8, &[(0, 2)], None),
    // #9 x7 -- plain straight.
    // 18xx: `path=a:0,b:3`
    (9, 0b00_1001, 0, TerrainType::Plain, TileColor::Yellow, 7, &[(0, 3)], None),
    // #55 x1 -- two towns, edges 0/1/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:4`
    (55, 0b01_1011, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (1, 4)], Some(10)),
    // #56 x1 -- two towns, edges 0/1/2/3.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:2;path=a:1,b:_1;path=a:_1,b:3`
    (56, 0b00_1111, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 2), (1, 3)], Some(10)),
    // #57 x4 -- THE yellow city tile -- every plain-city hex starts here.
    // 18xx: `city=revenue:20;path=a:0,b:_0;path=a:_0,b:3`
    (57, 0b00_1001, 0, TerrainType::MajorCityHub, TileColor::Yellow, 4, &[(0, 3)], Some(20)),
    // #58 x2 -- single town, gentle curve.
    // 18xx: `town=revenue:10;path=a:0,b:_0;path=a:_0,b:2`
    (58, 0b00_0101, 0, TerrainType::SmallTown, TileColor::Yellow, 2, &[(0, 2)], Some(10)),
    // #69 x1 -- two towns, edges 0/2/3/4.
    // 18xx: `town=revenue:10;town=revenue:10;path=a:0,b:_0;path=a:_0,b:3;path=a:2,b:_1;path=a:_1,b:4`
    (69, 0b01_1101, 0, TerrainType::DoubleTown, TileColor::Yellow, 1, &[(0, 3), (2, 4)], Some(10)),

    // ---- Green tier: unlocked by the room's first 3-train. ----
    // #14 x3 -- green city, edges 0/1/3/4.
    // 18xx: `city=revenue:30,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:3,b:_0;path=a:4,b:_0`
    (14, 0b01_1011, 0, TerrainType::MajorCityHub, TileColor::Green, 3, &[
        (0, 1), (0, 3), (0, 4), (1, 3), (1, 4), (3, 4)
    ], Some(30)),
    // #15 x2 -- green city, edges 0/1/2/3.
    // 18xx: `city=revenue:30,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:2,b:_0;path=a:3,b:_0`
    (15, 0b00_1111, 0, TerrainType::MajorCityHub, TileColor::Green, 2, &[
        (0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)
    ], Some(30)),
    // #16 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:2;path=a:1,b:3`
    (16, 0b00_1111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 2), (1, 3)], None),
    // #18 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:3;path=a:1,b:2`
    (18, 0b00_1111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (1, 2)], None),
    // #19 x1 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4`
    (19, 0b01_1101, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (2, 4)], None),
    // #20 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4`
    (20, 0b01_1011, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (1, 4)], None),
    // #23 x3 -- plain, edges 0/3/4.
    // 18xx: `path=a:0,b:3;path=a:0,b:4`
    (23, 0b01_1001, 0, TerrainType::Plain, TileColor::Green, 3, &[(0, 3), (0, 4)], None),
    // #24 x3 -- plain, edges 0/2/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:2`
    (24, 0b00_1101, 0, TerrainType::Plain, TileColor::Green, 3, &[(0, 2), (0, 3)], None),
    // #25 x1 -- plain, edges 0/2/4.
    // 18xx: `path=a:0,b:2;path=a:0,b:4`
    (25, 0b01_0101, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 2), (0, 4)], None),
    // #26 x1 -- plain, edges 0/3/5.
    // 18xx: `path=a:0,b:3;path=a:0,b:5`
    (26, 0b10_1001, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 3), (0, 5)], None),
    // #27 x1 -- plain, edges 0/1/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:1`
    (27, 0b00_1011, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 1), (0, 3)], None),
    // #28 x1 -- plain, edges 0/4/5.
    // 18xx: `path=a:0,b:4;path=a:0,b:5`
    (28, 0b11_0001, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 4), (0, 5)], None),
    // #29 x1 -- plain, edges 0/1/2.
    // 18xx: `path=a:0,b:2;path=a:0,b:1`
    (29, 0b00_0111, 0, TerrainType::Plain, TileColor::Green, 1, &[(0, 1), (0, 2)], None),
    // #53 x2 -- "B" label -- Boston AND Baltimore, edges 0/2/4.
    // 18xx: `city=revenue:50;path=a:0,b:_0;path=a:2,b:_0;path=a:4,b:_0;label=B`
    (53, 0b01_0101, 0, TerrainType::BostonHub, TileColor::Green, 2, &[(0, 2), (0, 4), (2, 4)], Some(50)),
    // #54 x1 -- "NY" label -- two cities, edges 0/1/2/3.
    // 18xx: `city=revenue:60,loc:0.5;city=revenue:60,loc:2.5;path=a:0,b:_0;path=a:_0,b:1;path=a:2,b:_1;path=a:_1,b:3;label=NY`
    (54, 0b00_1111, 0, TerrainType::NewYorkHub, TileColor::Green, 1, &[(0, 1), (2, 3)], Some(60)),
    // #59 x2 -- "OO" label -- two cities, edges 0/2.
    // 18xx: `city=revenue:40;city=revenue:40;path=a:0,b:_0;path=a:2,b:_1;label=OO`
    // NOTE: 0>stop 2>stop -- `e>stop` is a terminal spur (enter and stop, never pass through).
    (59, 0b00_0101, 0, TerrainType::DoubleCityHub, TileColor::Green, 2, &[(0, 0), (2, 2)], Some(40)),

    // ---- Brown tier: unlocked by the room's first 5-train. ----
    // #39 x1 -- plain, edges 0/1/2.
    // 18xx: `path=a:0,b:2;path=a:0,b:1;path=a:1,b:2`
    (39, 0b00_0111, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 2), (1, 2)], None),
    // #40 x1 -- plain, edges 0/2/4.
    // 18xx: `path=a:0,b:2;path=a:2,b:4;path=a:0,b:4`
    (40, 0b01_0101, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 2), (0, 4), (2, 4)], None),
    // #41 x2 -- plain, edges 0/1/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:1;path=a:1,b:3`
    (41, 0b00_1011, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 1), (0, 3), (1, 3)], None),
    // #42 x2 -- plain, edges 0/3/5.
    // 18xx: `path=a:0,b:3;path=a:3,b:5;path=a:0,b:5`
    (42, 0b10_1001, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 3), (0, 5), (3, 5)], None),
    // #43 x2 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:3;path=a:0,b:2;path=a:1,b:3;path=a:1,b:2`
    (43, 0b00_1111, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 2), (0, 3), (1, 2), (1, 3)], None),
    // #44 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4;path=a:0,b:1;path=a:3,b:4`
    (44, 0b01_1011, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 3), (1, 4), (3, 4)], None),
    // #45 x2 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4;path=a:0,b:4;path=a:2,b:3`
    (45, 0b01_1101, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 3), (0, 4), (2, 3), (2, 4)], None),
    // #46 x2 -- plain, edges 0/2/3/4.
    // 18xx: `path=a:0,b:3;path=a:2,b:4;path=a:3,b:4;path=a:0,b:2`
    (46, 0b01_1101, 0, TerrainType::Plain, TileColor::Brown, 2, &[(0, 2), (0, 3), (2, 4), (3, 4)], None),
    // #47 x1 -- plain, edges 0/1/3/4.
    // 18xx: `path=a:0,b:3;path=a:1,b:4;path=a:1,b:3;path=a:0,b:4`
    (47, 0b01_1011, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 3), (0, 4), (1, 3), (1, 4)], None),
    // #61 x2 -- "B" label -- Boston AND Baltimore, edges 0/2/3/4.
    // 18xx: `city=revenue:60;path=a:0,b:_0;path=a:2,b:_0;path=a:3,b:_0;path=a:4,b:_0;label=B`
    (61, 0b01_1101, 0, TerrainType::BostonHub, TileColor::Brown, 2, &[
        (0, 2), (0, 3), (0, 4), (2, 3), (2, 4), (3, 4)
    ], Some(60)),
    // #62 x1 -- "NY" label -- two cities, edges 0/1/2/3.
    // 18xx: `city=revenue:80,slots:2;city=revenue:80,slots:2;path=a:0,b:_0;path=a:_0,b:1;path=a:2,b:_1;path=a:_1,b:3;label=NY`
    (62, 0b00_1111, 0, TerrainType::NewYorkHub, TileColor::Brown, 1, &[(0, 1), (2, 3)], Some(90)),
    // #63 x3 -- brown city, all six edges.
    // 18xx: `city=revenue:40,slots:2;path=a:0,b:_0;path=a:1,b:_0;path=a:2,b:_0;path=a:3,b:_0;path=a:4,b:_0;path=a:5,b:_0`
    (63, 0b11_1111, 0, TerrainType::MajorCityHub, TileColor::Brown, 3, &[
        (0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (1, 2), (1, 3), (1, 4), (1, 5), (2, 3), (2, 4),
        (2, 5), (3, 4), (3, 5), (4, 5)
    ], Some(40)),
    // #64 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50,loc:3.5;path=a:0,b:_0;path=a:_0,b:2;path=a:3,b:_1;path=a:_1,b:4;label=OO`
    (64, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 2), (3, 4)], Some(50)),
    // #65 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50,loc:2.5;path=a:0,b:_0;path=a:_0,b:4;path=a:2,b:_1;path=a:_1,b:3;label=OO`
    (65, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 4), (2, 3)], Some(50)),
    // #66 x1 -- "OO" label, edges 0/1/2/3.
    // 18xx: `city=revenue:50;city=revenue:50,loc:1.5;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:2;label=OO`
    (66, 0b00_1111, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (1, 2)], Some(50)),
    // #67 x1 -- "OO" label, edges 0/2/3/4.
    // 18xx: `city=revenue:50;city=revenue:50;path=a:0,b:_0;path=a:_0,b:3;path=a:2,b:_1;path=a:_1,b:4;label=OO`
    (67, 0b01_1101, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (2, 4)], Some(50)),
    // #68 x1 -- "OO" label, edges 0/1/3/4.
    // 18xx: `city=revenue:50;city=revenue:50;path=a:0,b:_0;path=a:_0,b:3;path=a:1,b:_1;path=a:_1,b:4;label=OO`
    (68, 0b01_1011, 0, TerrainType::DoubleCityHub, TileColor::Brown, 1, &[(0, 3), (1, 4)], Some(50)),
    // #70 x1 -- plain, edges 0/1/2/3.
    // 18xx: `path=a:0,b:1;path=a:0,b:2;path=a:1,b:3;path=a:2,b:3`
    (70, 0b00_1111, 0, TerrainType::Plain, TileColor::Brown, 1, &[(0, 1), (0, 2), (1, 3), (2, 3)], None),
];

/// Fixed axial coordinates of 1830's three landmark cities -- New York G19,
/// Boston E23, Baltimore I15 -- reserved for their designated artwork (module
/// doc comment #11).
///
/// Real board coordinates, converted by `r = row_letter_index (A=0..K=10)`,
/// `q = (column_number - 1 - r) / 2`, and kept in lockstep with the frontend's
/// identical `LANDMARK_HEXES`.
pub const LANDMARK_HEXES: &[(&str, i32, i32)] =
    &[("New York", 6, 6), ("Boston", 9, 4), ("Baltimore", 3, 8)];

/// Returns the landmark name registered at `(q, r)`, or `None` if it's an
/// ordinary (non-reserved) hex.
pub fn landmark_name_at(q: i32, r: i32) -> Option<&'static str> {
    LANDMARK_HEXES
        .iter()
        .find(|(_, lq, lr)| *lq == q && *lr == r)
        .map(|(name, _, _)| *name)
}

/// True when `landmark` is one of the two real 1830 hexes printed with the "B"
/// label -- Boston and Baltimore (module doc comment #27). Centralized so the
/// City Reservation block in `execute_lay_tile` and its mirror in
/// `legal_tile_placements` cannot drift on the list.
fn is_b_label_hex(landmark: Option<&str>) -> bool {
    matches!(landmark, Some("Boston") | Some("Baltimore"))
}

/// Fixed axial coordinates of 1830's seven real red off-board revenue
/// terminals: Chicago (F2), Canadian West (A9 and A11 -- two distinct
/// hexes, both feeding the same named destination), Gulf (I1 and J2 --
/// likewise two hexes), Deep South (K13), and Maritime Provinces (B24).
/// Converted into axial coordinates by the identical transform
/// `LANDMARK_HEXES` uses, and kept in lockstep with the frontend's
/// `OFFBOARD_LABELS`/`STATIC_BOARD_HEXES` (`RedOffboard` entries) in
/// `HexGridRenderer.tsx`, which label the same seven hexes. See
/// `offboard_name_at`/`HexMapError::OffboardHexNotBuildable` for how these
/// are enforced as permanently unbuildable -- off-board hexes are printed
/// revenue destinations on the physical board, never track a Protocol lays
/// tile artwork onto.
pub const OFFBOARD_HEXES: &[(&str, i32, i32)] = &[
    ("Chicago", -2, 5),
    ("Canadian West", 4, 0),
    ("Canadian West", 5, 0),
    ("Gulf", -4, 8),
    ("Gulf", -4, 9),
    ("Deep South", 1, 10),
    ("Maritime Provinces", 11, 1),
];

/// Returns the off-board destination name registered at `(q, r)`, or `None`
/// if it's not one of the seven reserved off-board hexes.
pub fn offboard_name_at(q: i32, r: i32) -> Option<&'static str> {
    OFFBOARD_HEXES
        .iter()
        .find(|(_, oq, or_)| *oq == q && *or_ == r)
        .map(|(name, _, _)| *name)
}

/// Every hex bearing a preprinted CITY marker on the real 1830 board (module
/// doc comment #16): six real GRAY cities with printed track (Lansing D2,
/// Cleveland F6, Altoona H12, Rochester D14, Richmond K15, Montreal A19), plus
/// nine ordinary WHITE city hexes with a bare marker and no track (Toledo F4,
/// Providence F22, Pittsburgh H10, Columbus H4, Washington J14, Lancaster H16,
/// Ottawa B16, Barrie B10, Albany E19).
///
/// The reservation gate cares only which tile TYPE is legal at a hex, not
/// whether the hex also carries printed track, so both groups belong here.
///
/// Verbatim from `tobymao/18xx`'s `g_1830/map.rb`. B16 is Ottawa -- the
/// originating request said "Barrington", which the source does not support.
///
/// The four OO double-city hexes were split out into `OO_DESIGNATED_HEXES`
/// (module doc comment #18); they still belong to "every hex whose printed
/// infrastructure includes a City", they just require different artwork.
///
/// Kept in lockstep with the frontend's `GRAY_HEXES` (`marker: "city"`).
pub const CITY_DESIGNATED_HEXES: &[(&str, i32, i32)] = &[
    ("Lansing", -1, 3),
    ("Cleveland", 0, 5),
    ("Altoona", 2, 7),
    ("Rochester", 5, 3),
    ("Richmond", 2, 10),
    ("Montreal", 9, 0),
    ("Toledo", -1, 5),
    ("Providence", 8, 5),
    ("Pittsburgh", 1, 7),
    ("Columbus", -2, 7),
    ("Washington", 2, 9),
    ("Lancaster", 4, 7),
    ("Ottawa", 7, 1),
    ("Barrie", 4, 1),
    ("Albany", 7, 4),
];

/// Returns the preprinted city-designation name registered at `(q, r)`, or
/// `None` if it's not one of `CITY_DESIGNATED_HEXES`. See module doc
/// comment #16. Does NOT match one of `OO_DESIGNATED_HEXES`' four
/// entries -- see that list's own `oo_designation_name_at` (module doc
/// comment #18).
pub fn city_designation_name_at(q: i32, r: i32) -> Option<&'static str> {
    CITY_DESIGNATED_HEXES
        .iter()
        .find(|(_, cq, cr)| *cq == q && *cr == r)
        .map(|(name, _, _)| *name)
}

/// The four preprinted YELLOW "OO" double-city hexes -- Detroit & Windsor E5,
/// Hamilton & Toronto D10, Dunkirk & Buffalo E11, Philadelphia & Trenton H18 --
/// split out of `CITY_DESIGNATED_HEXES` by module doc comment #18 because they
/// require `DoubleCityHub` artwork rather than plain `MajorCityHub`. Kept in
/// lockstep with the frontend's `YELLOW_OO_HEXES`.
pub const OO_DESIGNATED_HEXES: &[(&str, i32, i32)] = &[
    ("Detroit & Windsor", 0, 4),
    ("Hamilton & Toronto", 3, 3),
    ("Dunkirk & Buffalo", 3, 4),
    ("Philadelphia & Trenton", 5, 7),
];

/// Returns the preprinted OO double-city-designation name registered at
/// `(q, r)`, or `None` if it's not one of `OO_DESIGNATED_HEXES`' four
/// entries. See module doc comment #18.
pub fn oo_designation_name_at(q: i32, r: i32) -> Option<&'static str> {
    OO_DESIGNATED_HEXES
        .iter()
        .find(|(_, oq, or_)| *oq == q && *or_ == r)
        .map(|(name, _, _)| *name)
}

/// Station Tokens (module doc comment #23/#25): `(company_id, q, r, hex_label)`
/// for all eight corporations. Every `(q, r)` is copied verbatim from this
/// file's own landmark/city/OO lists, never a new coordinate.
///
/// HOUSE RULE, not real 1830: NYC is Albany E19 and NNH is New York G19. The
/// real board gives NYC New York and has NYNH share that same hex.
pub const CORPORATION_HOME_HEX: &[(u32, i32, i32, &str)] = &[
    (1, 2, 7, "H12"), // PRR -> Altoona
    (2, 7, 4, "E19"), // NYC -> Albany (house rule, module doc comment #25)
    (3, 9, 0, "A19"), // CPR -> Montreal
    (4, 3, 8, "I15"), // B&O -> Baltimore
    (5, 0, 5, "F6"),  // C&O -> Cleveland
    (6, 3, 4, "E11"), // ERIE -> Dunkirk & Buffalo (shared OO hex, see module doc comment #23)
    (7, 6, 6, "G19"), // NNH ("NYNH") -> New York (house rule, module doc comment #25)
    (8, 9, 4, "E23"), // B&M -> Boston
];

/// Returns `company_id`'s preprinted home hex. As of module doc comment
/// #25's house rule, every one of the eight `CORE_PUBLIC_COMPANIES` has an
/// assigned home, so this returns `Some` in all eight cases; `None` remains
/// possible only for an unrecognized `company_id`. See `CORPORATION_HOME_HEX`.
pub fn corporation_home_hex(company_id: u32) -> Option<(i32, i32, &'static str)> {
    CORPORATION_HOME_HEX
        .iter()
        .find(|(id, ..)| *id == company_id)
        .map(|(_, q, r, label)| (*q, *r, *label))
}

/// Station Tokens (module doc comment #23): each corporation's total token
/// count, home token included -- sourced directly from the requester rather
/// than either of two disagreeing secondary sources (see module doc comment
/// #23's own paragraph on that source conflict).
pub const STATION_TOKEN_LIMIT: &[(u32, u8)] = &[
    (1, 4), // PRR
    (2, 4), // NYC
    (3, 4), // CPR
    (4, 3), // B&O
    (5, 3), // C&O
    (6, 3), // ERIE
    (7, 2), // NNH
    (8, 2), // B&M
];

/// Returns `company_id`'s total Station Token limit (home token included),
/// or a conservative default of `3` for any `company_id` outside
/// `public_company::CORE_PUBLIC_COMPANIES` (shouldn't happen in practice --
/// every core company has an explicit entry above).
pub fn station_token_limit(company_id: u32) -> u8 {
    STATION_TOKEN_LIMIT
        .iter()
        .find(|(id, _)| *id == company_id)
        .map(|(_, limit)| *limit)
        .unwrap_or(3)
}

/// Station Tokens: the VGP cost of the token being placed, where
/// `token_ordinal` is 1-based -- call with `existing_token_count + 1`, never a
/// 0-based index. 1st free, 2nd 40 VGP, every one after a flat 100 VGP.
///
/// The `1 => zero()` arm exists so the function stays total if ever called for
/// a real first token some other way. The cost progression is the one part the
/// rulebook and the secondary source did NOT disagree on (module doc note #23).
pub fn station_token_cost(token_ordinal: u8) -> Uint128 {
    match token_ordinal {
        0 | 1 => Uint128::zero(),
        2 => Uint128::new(40),
        _ => Uint128::new(100),
    }
}

/// Grants `company_id`'s free home Station Token the moment it floats, if
/// `corporation_home_hex` has an entry. A no-op if a token is already recorded
/// (defensive; a company floats once per game).
///
/// Writes only to `PROTOCOL_STATION_HEXES`, deliberately never touching
/// `PROTOCOL_NETWORK_HEXES` or the treasury -- the home token is informational
/// and does not anchor where track may grow from (module doc comment #23).
///
/// Called from `auction::award_bo_president_share` and
/// `trading::execute_buy_stock`'s float branch, the only two places
/// `PublicCompany::is_floated` flips false -> true.
pub fn grant_home_station_token(
    storage: &mut dyn Storage,
    game_id: u64,
    company_id: u32,
) -> Result<(), StdError> {
    let Some((home_q, home_r, _label)) = corporation_home_hex(company_id) else {
        return Ok(());
    };
    let mut token_hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
        .may_load(storage, (game_id, company_id))?
        .unwrap_or_default();
    if token_hexes.contains(&(home_q, home_r)) {
        return Ok(());
    }
    token_hexes.push((home_q, home_r));
    PROTOCOL_STATION_HEXES.save(storage, (game_id, company_id), &token_hexes)?;

    // Audit G-12: record WHICH city this home token occupies, not just which hex,
    // so it is visible to `hex_token_occupants` through the real registry rather
    // than only through its city-0 reconstruction fallback.
    //
    // `first_open_city` rather than a hardcoded 0 so a home hex redefined onto
    // multi-city artwork stays correct. `unwrap_or(0)` keeps the grant infallible
    // rather than introducing a new way for a float to fail.
    let slot_counts = city_slot_counts_at(storage, game_id, home_q, home_r)?;
    let occupants = hex_token_occupants(storage, game_id, home_q, home_r)?;
    let city_index = first_open_city(slot_counts, &occupants).unwrap_or(0);
    let mut hex_tokens: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(storage, (game_id, home_q, home_r))?
        .unwrap_or_default();
    if !hex_tokens.iter().any(|(id, _)| *id == company_id) {
        hex_tokens.push((company_id, city_index));
        HEX_STATION_TOKENS.save(storage, (game_id, home_q, home_r), &hex_tokens)?;
    }
    Ok(())
}

/// Real, individually-sourced starting face values for the six preprinted-track
/// hexes the Landmark Pathfinder Revenue Fix covers (module doc comment
/// #17/#20): New York $40, Boston $30, Baltimore $30, Montreal $40, Cleveland
/// $30, Altoona $10. Verified against `g_1830/map.rb` and kept in lockstep with
/// the frontend's `HEX_START_VALUE_OVERRIDE`.
///
/// Altoona is genuinely a City (`city=revenue:10`, not `town=`) worth a sourced
/// $10, not the generic flat $20 it fell through to before.
///
/// Lansing, Rochester and Richmond are deliberately absent: no individually-
/// sourced figure for them has been verified, so they stay on the flat lookup
/// rather than a guess. Chicago is not here either -- it is an off-board
/// destination on its own era-tiered system.
pub const LANDMARK_START_VALUE_OVERRIDE: &[(i32, i32, u128)] = &[
    (6, 6, 40), // New York (G19)
    (9, 4, 30), // Boston (E23)
    (3, 8, 30), // Baltimore (I15)
    (9, 0, 40), // Montreal (A19)
    (0, 5, 30), // Cleveland (F6) -- NOT "Chicago"; see doc comment above
    (2, 7, 10), // Altoona (H12) -- real City, NOT a Town; see module doc comment #20
];

/// Returns the Landmark Pathfinder Revenue Fix's real starting value at
/// `(q, r)`, or `None` if it's not one of the six hexes
/// `LANDMARK_START_VALUE_OVERRIDE` covers. See module doc comment #17/#20 and
/// `pathfinding.rs`'s `effective_tile_and_value` for how this is applied.
pub fn landmark_start_value_at(q: i32, r: i32) -> Option<Uint128> {
    LANDMARK_START_VALUE_OVERRIDE
        .iter()
        .find(|(lq, lr, _)| *lq == q && *lr == r)
        .map(|(_, _, value)| Uint128::new(*value))
}

/// Every hex bearing a preprinted Town or Double-Town designation (module doc
/// comment #16): three real GRAY single-town hexes with printed track (Kingston
/// C15, Atlantic City I19, F24), four white single-town hexes with a bare
/// marker (London E7, Burlington B20, Flint D4, Erie F10), and three white
/// DOUBLE-town hexes (Akron & Canton G7, Reading & Allentown G17, New Haven &
/// Hartford F20). Verbatim from `g_1830/map.rb`.
///
/// The trailing `bool` is `true` for a Double-Town, used only for the error
/// message -- both designations accept `SmallTown` or `DoubleTown` artwork.
///
/// F24 reads "Fall River", a deliberate house-rule display override; the real
/// board name is Mansfield. Cosmetic only -- it changes no coordinate, no gate
/// and no rule. Kept in lockstep with the frontend's `NAMED_HEX_LABELS`.
pub const TOWN_DESIGNATED_HEXES: &[(&str, i32, i32, bool)] = &[
    ("Kingston", 6, 2, false),
    ("Atlantic City", 5, 8, false),
    ("Fall River", 9, 5, false), // real board name: Mansfield -- see doc comment above
    ("London", 1, 4, false),
    ("Burlington", 9, 1, false),
    ("Flint", 0, 3, false),
    ("Erie", 2, 5, false),
    ("Akron & Canton", 0, 6, true),
    ("Reading & Allentown", 5, 6, true),
    ("New Haven & Hartford", 7, 5, true),
];

/// Returns `(name, is_double)` for the preprinted Town/Double-Town
/// designation registered at `(q, r)`, or `None` if it's not one of
/// `TOWN_DESIGNATED_HEXES`. See module doc comment #16.
pub fn town_designation_at(q: i32, r: i32) -> Option<(&'static str, bool)> {
    TOWN_DESIGNATED_HEXES
        .iter()
        .find(|(_, tq, tr, _)| *tq == q && *tr == r)
        .map(|(name, _, _, is_double)| (*name, *is_double))
}

/// Every hex with real, permanent, non-upgradeable GRAY preprinted track
/// (module doc comment #19/#20). Twelve entries: the six GRAY cities and three
/// GRAY towns already identified by the two lists above, PLUS the three bare
/// GRAY connector hexes (E9, A17, D24) that carry fixed track but no marker.
///
/// The three connectors were a data-widening fix, not new sourcing: coordinates
/// came from this file's own `BOARD_HEX_LABELS` and cross-checked against the
/// frontend's `GRAY_HEXES`, which already carried all twelve.
///
/// E9/A17/D24 have no real place name, so their display name is their label.
pub const GRAY_PREPRINTED_HEXES: &[(&str, i32, i32)] = &[
    ("Lansing", -1, 3),
    ("Cleveland", 0, 5),
    ("Altoona", 2, 7),
    ("Rochester", 5, 3),
    ("Richmond", 2, 10),
    ("Montreal", 9, 0),
    ("Kingston", 6, 2),
    ("Atlantic City", 5, 8),
    ("Fall River", 9, 5), // real board name: Mansfield -- see TOWN_DESIGNATED_HEXES's own doc comment
    ("E9", 2, 4),   // bare GRAY connector, no city/town -- module doc comment #20
    ("A17", 8, 0),  // bare GRAY connector, no city/town -- module doc comment #20
    ("D24", 10, 3), // bare GRAY connector, no city/town -- module doc comment #20
];

/// Returns the real GRAY pre-printed hex's name registered at `(q, r)`, or
/// `None` if it's not one of `GRAY_PREPRINTED_HEXES`' twelve entries. See
/// module doc comment #19/#20 -- checked unconditionally in both
/// `execute_lay_tile` and `legal_tile_placements`, immediately after
/// Off-Board Reservation, before any tile artwork is even considered.
pub fn gray_preprinted_name_at(q: i32, r: i32) -> Option<&'static str> {
    GRAY_PREPRINTED_HEXES
        .iter()
        .find(|(_, gq, gr)| *gq == q && *gr == r)
        .map(|(name, _, _)| *name)
}

/// Private-Company-Reserved Hexes (module doc comment #24). Each entry is
/// `(board label, q, r, private_id)`. Track may only be laid there by the
/// corporation that owns the matching private via `owner_protocol_id` -- a
/// player-only `owner` does NOT unlock the hex. The block lifts permanently
/// once that private's `closed` flag is set.
///
/// DIVERGENCE: this file gives F16 to the Mohawk & Hudson; the frontend has
/// F16 as Scranton, the Delaware & Hudson's hex, and gives the M&H no reserved
/// ground at all. Unresolved -- see rust_contract_architecture.md.
pub const PRIVATE_RESERVED_HEXES: &[(&str, i32, i32, u32)] = &[
    ("B20", 9, 1, 3), // Burlington -- Delaware & Hudson
    ("F16", 5, 5, 4), // Mohawk & Hudson
];

/// Returns `Some((board label, private_id))` if `(q, r)` is one of
/// `PRIVATE_RESERVED_HEXES`' two entries, else `None`. Mirrors
/// `gray_preprinted_name_at`'s shape.
pub fn private_reserved_hex_at(q: i32, r: i32) -> Option<(&'static str, u32)> {
    PRIVATE_RESERVED_HEXES
        .iter()
        .find(|(_, pq, pr, _)| *pq == q && *pr == r)
        .map(|(label, _, _, private_id)| (*label, *private_id))
}

/// Shared check for `execute_lay_tile` and `legal_tile_placements` (module doc
/// comment #24). `Ok(true)` means blocked.
///
/// FAIL-CLOSED: a missing private company record is treated as still blocking.
/// Unblocked only when the hex is not reserved, or the private is `closed`, or
/// `owner_protocol_id` already equals `protocol_id`.
fn private_reserved_hex_blocks(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
) -> Result<bool, HexMapError> {
    let Some((_, private_id)) = private_reserved_hex_at(q, r) else {
        return Ok(false);
    };
    let private: Option<PrivateCompany> = PRIVATE_COMPANIES.may_load(storage, (game_id, private_id))?;
    match private {
        None => Ok(true),
        Some(private) => {
            if private.closed {
                return Ok(false);
            }
            Ok(private.owner_protocol_id != Some(protocol_id))
        }
    }
}

/// Coordinate Symmetries: the complete, authoritative real 1830 board --
/// every one of its 93 hexes' printed row-letter/column-number label (e.g.
/// `"G19"`) paired with the axial `(q, r)` this contract's own coordinate
/// system converts it to. This is the single source of truth
/// `label_for_axial`/`axial_for_label`/`describe_hex` all read from, so
/// every coordinate this contract ever stores, queries, or raises an error
/// about can be resolved back to the exact label a human could check
/// against the physical board or `frontend/src/components/HexGridRenderer.tsx`'s
/// identical `STATIC_BOARD_HEXES` table (this array is a byte-for-byte port
/// of that one, including all 93 entries and their `(q, r)` values) -- a
/// bare `(q, r)` pair alone is not considered sufficient traceability
/// anywhere in this module. `(q, r)` remains the actual storage/message key
/// throughout this contract (unchanged, and itself already the literal,
/// un-abstracted transform of the real board's own labels: `r = row-letter
/// index (A=0..K=10)`, `q = (column_number - 1 - r) / 2`) -- this table adds
/// auditability on top of that, it does not replace it. This includes the
/// three `LANDMARK_HEXES` and seven `OFFBOARD_HEXES` entries too (their
/// labels are re-derivable from here, though those two constants keep their
/// own copies since they also carry the landmark/off-board *names*, not
/// just the printed coordinate).
pub const BOARD_HEX_LABELS: &[(&str, i32, i32)] = &[
    // Row A
    ("A9", 4, 0),
    ("A11", 5, 0),
    ("A17", 8, 0),
    ("A19", 9, 0),
    // Row B
    ("B10", 4, 1),
    ("B12", 5, 1),
    ("B14", 6, 1),
    ("B16", 7, 1),
    ("B18", 8, 1),
    ("B20", 9, 1),
    ("B22", 10, 1),
    ("B24", 11, 1),
    // Row C
    ("C7", 2, 2),
    ("C9", 3, 2),
    ("C11", 4, 2),
    ("C13", 5, 2),
    ("C15", 6, 2),
    ("C17", 7, 2),
    ("C19", 8, 2),
    ("C21", 9, 2),
    ("C23", 10, 2),
    // Row D
    ("D2", -1, 3),
    ("D4", 0, 3),
    ("D6", 1, 3),
    ("D8", 2, 3),
    ("D10", 3, 3),
    ("D12", 4, 3),
    ("D14", 5, 3),
    ("D16", 6, 3),
    ("D18", 7, 3),
    ("D20", 8, 3),
    ("D22", 9, 3),
    ("D24", 10, 3),
    // Row E
    ("E3", -1, 4),
    ("E5", 0, 4),
    ("E7", 1, 4),
    ("E9", 2, 4),
    ("E11", 3, 4),
    ("E13", 4, 4),
    ("E15", 5, 4),
    ("E17", 6, 4),
    ("E19", 7, 4),
    ("E21", 8, 4),
    ("E23", 9, 4), // Boston
    // Row F
    ("F2", -2, 5), // Chicago
    ("F4", -1, 5),
    ("F6", 0, 5),
    ("F8", 1, 5),
    ("F10", 2, 5),
    ("F12", 3, 5),
    ("F14", 4, 5),
    ("F16", 5, 5),
    ("F18", 6, 5),
    ("F20", 7, 5),
    ("F22", 8, 5),
    ("F24", 9, 5),
    // Row G
    ("G3", -2, 6),
    ("G5", -1, 6),
    ("G7", 0, 6),
    ("G9", 1, 6),
    ("G11", 2, 6),
    ("G13", 3, 6),
    ("G15", 4, 6),
    ("G17", 5, 6),
    ("G19", 6, 6), // New York
    // Row H
    ("H2", -3, 7),
    ("H4", -2, 7),
    ("H6", -1, 7),
    ("H8", 0, 7),
    ("H10", 1, 7),
    ("H12", 2, 7),
    ("H14", 3, 7),
    ("H16", 4, 7),
    ("H18", 5, 7),
    // Row I
    ("I1", -4, 8), // Gulf
    ("I3", -3, 8),
    ("I5", -2, 8),
    ("I7", -1, 8),
    ("I9", 0, 8),
    ("I11", 1, 8),
    ("I13", 2, 8),
    ("I15", 3, 8), // Baltimore
    ("I17", 4, 8),
    ("I19", 5, 8),
    // Row J
    ("J2", -4, 9), // Gulf
    ("J4", -3, 9),
    ("J6", -2, 9),
    ("J8", -1, 9),
    ("J10", 0, 9),
    ("J12", 1, 9),
    ("J14", 2, 9),
    // Row K
    ("K13", 1, 10), // Deep South
    ("K15", 2, 10),
];

/// Returns `(q, r)`'s real 1830 board label (e.g. `"G19"`), or `None` if
/// `(q, r)` isn't one of the real board's 93 hexes -- see `BOARD_HEX_LABELS`.
pub fn label_for_axial(q: i32, r: i32) -> Option<&'static str> {
    BOARD_HEX_LABELS
        .iter()
        .find(|(_, lq, lr)| *lq == q && *lr == r)
        .map(|(label, _, _)| *label)
}

/// Returns the axial `(q, r)` a real 1830 board label (e.g. `"G19"`)
/// resolves to, or `None` if `label` isn't one of the real board's 93
/// hexes. The inverse of `label_for_axial` -- mainly useful for tests and
/// any future off-chain tooling that wants to address a hex by its printed
/// label rather than hand-computing the axial transform.
pub fn axial_for_label(label: &str) -> Option<(i32, i32)> {
    BOARD_HEX_LABELS
        .iter()
        .find(|(l, _, _)| *l == label)
        .map(|(_, q, r)| (*q, *r))
}

/// Resolves `(q, r)` to a human-checkable string for error messages, query
/// responses and test assertions, so nothing has to eyeball a bare axial pair
/// against the physical board.
///
/// Unlike `label_for_axial` this never returns `None`: a coordinate off the
/// real 93-hex board still gets a clearly-marked string rather than forcing
/// every caller to handle a missing label.
pub fn describe_hex(q: i32, r: i32) -> String {
    match label_for_axial(q, r) {
        Some(label) => label.to_string(),
        None => format!("({q}, {r}) [off the authentic 1830 board]"),
    }
}

/// The flat VGP revenue bucket for each `TerrainType`: Plain $0, Mountain $0,
/// Small Town $10, Major City Hub $20, DoubleTown $10, DoubleCityHub $40.
///
/// Plain and mountain track is a pure CONNECTOR with no printed revenue --
/// giving them a nonzero figure let a company earn money by laying ordinary
/// track with no town or city anywhere on its route.
///
/// DELIBERATELY NOT HEX-SPECIFIC. A frontend pass gave five hexes real sourced
/// figures and asked for the change on "both layers"; it was applied only
/// there, for two reasons. This function is live payout math, so a per-hex
/// figure would change every laid tile's revenue at those hexes for the rest of
/// the game across every tier -- far more than the "value plate" the request
/// described. And it is never even CALLED for a landmark before a tile is laid
/// there, since `trace_best_route` skips any coordinate absent from `MAP_GRID`
/// -- so the live starting value was already $0 uniformly.
///
/// Audit G-11 layered the tile's own printed revenue in front of this; see
/// `tile_base_value`, the single site that resolves the two.
pub fn terrain_base_value(terrain: TerrainType) -> Uint128 {
    Uint128::new(match terrain {
        TerrainType::Plain => 0,
        // Audit G-5/G-10: NO tile carries this terrain any more -- real 1830 has no
        // mountain tile, mountains are printed on the BOARD and the fee comes from
        // `terrain_build_fee(q, r)`.
        //
        // The variant is retained so this match stays exhaustive, so already-stored
        // `Tile` records deserialize unchanged, and so the frontend's enum needs no
        // lockstep change. Scored 0 either way: bare mountain track was never a
        // revenue centre.
        TerrainType::MountainRugged => 0,
        TerrainType::SmallTown => 10,
        TerrainType::DoubleTown => 10, // module doc comment #21: corrected DOWN from an earlier "two $10 stops sharing one hex" $20 -- a route visits this hex once and prices it once, same single-visit rule DoubleCityHub's own $80->$40 correction (module doc comment #18/#20) already established; a double town's two circles don't connect intra-hex any more than a double city's two stations do, so only one $10 stop is ever actually reached per pass.
        TerrainType::MajorCityHub => 20,
        TerrainType::DoubleCityHub => 40, // real 1830 tile 59's per-station $40 (module doc comment #18), NOT both stations at once -- corrected back down from an earlier pass's $80, which wrongly credited both of tile 59's stations on a single visit even though the tile's real path data leaves them disconnected, so a single continuous transit can only ever reach ONE station per pass. See module doc comment #20's follow-up correction paragraph for the full reasoning.
        TerrainType::BostonHub => 20, // module doc comment #26: same flat single-city bucket as MajorCityHub -- Boston's own real printed revenue (real 1830: $30, tobymao/18xx-sourced) is DELIBERATELY not ported here either, same "not hex-specific, live payout math" reasoning this function's own doc comment already gives for MajorCityHub/DoubleCityHub; the frontend's HEX_START_VALUE_OVERRIDE remains the only place a real per-hex figure is shown.
        TerrainType::NewYorkHub => 40, // module doc comment #26: same flat per-station bucket as DoubleCityHub (both are two-station hub artwork, single-visit-per-pass pricing per DoubleCityHub's own note above) -- real 1830's own $40/station figure for New York's green tile happens to already match this flat bucket, a coincidence, not a hex-specific override (same reasoning as BostonHub above).
    })
}

/// Looks up `tile_id`'s fixed base revenue value -- its `TerrainType` from
/// `TILE_CATALOG`, resolved through `terrain_base_value` -- or `None` if no
/// such tile exists. Used by `pathfinding.rs` when summing an Operating
/// Round route's total value.
pub fn tile_base_value(tile_id: u32) -> Option<Uint128> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, terrain, _color, _qty, _paths, revenue)| {
            // Audit G-11: the tile's OWN printed revenue wins; the flat bucket is the
            // fallback for entries that have none. The single point the engine prices a
            // hex through, so adding the override here moves every payout path at once.
            //
            // `terrain_base_value` prices by `TerrainType`, of which there are seven,
            // across 46 tiles -- structurally unable to express real 1830, where revenue
            // is a property of the printed TILE. #62 and #64 are both two-city brown
            // artwork and print $90 and $50; under the terrain model they were
            // necessarily equal, and both wrong.
            //
            // The bucket is KEPT rather than deleted so a future tile added without a
            // sourced figure prices sanely instead of silently paying zero.
            revenue.map_or_else(|| terrain_base_value(terrain), |value| Uint128::new(value as u128))
        })
}

/// `tile_id`'s own printed revenue as published in `TILE_CATALOG`, or `None`
/// when the entry has none and falls back to its terrain bucket (Audit
/// G-11). Surfaced on `msg::MapTileEntry::revenue` so a client renders the
/// same figure the contract will actually pay, rather than re-deriving it
/// from terrain and quietly disagreeing.
pub fn tile_printed_revenue(tile_id: u32) -> Option<u32> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .and_then(|(_, _, _, _terrain, _color, _qty, _paths, revenue)| revenue)
}

/// Looks up `tile_id`'s `TileColor` era tier, or `None` if no such tile
/// exists. Used by `execute_lay_tile` to resolve the color of a tile
/// already sitting on the map (for an upgrade's color-step check) without
/// needing to store the color redundantly on `state::Tile` itself.
pub fn tile_color_for(tile_id: u32) -> Option<TileColor> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, color, _qty, _paths, _revenue)| color)
}

/// Looks up `tile_id`'s `TerrainType`, or `None` if no such tile exists.
/// Used by `execute_place_station_token` (module doc comment #23) to check
/// that a Station Token's target hex already holds a laid
/// `MajorCityHub`/`DoubleCityHub` tile, mirroring `tile_color_for`'s exact
/// shape/purpose one field over.
pub fn tile_terrain_for(tile_id: u32) -> Option<TerrainType> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, terrain, _color, _qty, _paths, _revenue)| terrain)
}

/* ------------------------------------------------------------------ */
/* Tile Inventory Supply Engine (Audit G-5)                           */
/* ------------------------------------------------------------------ */

/// Looks up how many physical copies of `tile_id` a room starts with --
/// `TILE_CATALOG`'s sixth field -- or `None` if no such tile exists. See
/// `UNLIMITED_TILE_SUPPLY` for what the sentinel value means.
pub fn tile_starting_quantity(tile_id: u32) -> Option<u32> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, _color, quantity, _paths, _revenue)| quantity)
}

/// Seeds `game_id`'s tile tray with a full starting supply of every
/// `TILE_CATALOG` entry. Called once, when a game room is created
/// (`contract::execute_create_game_room`, alongside
/// `hardware::spawn_hardware_pool` and the company/market seeding), and
/// again by `gamelog::reapply_game_log` to reset the tray to genesis before
/// replaying the event log.
///
/// Writes every entry unconditionally (rather than skipping the unlimited
/// ones) so a room's tray is fully self-describing in state and a later
/// read never has to fall back on the catalog to know what it started with.
pub fn seed_tile_inventory(storage: &mut dyn Storage, game_id: u64) -> StdResult<()> {
    for (tile_id, _connections, _cost, _terrain, _color, quantity, _paths, _revenue) in
        TILE_CATALOG.iter().copied()
    {
        REMAINING_TILES.save(storage, (game_id, tile_id), &quantity)?;
    }
    Ok(())
}

/// How many copies of `tile_id` are still unlaid in `game_id`'s tray.
///
/// Falls back to `tile_starting_quantity` when no entry has been written
/// yet -- defensive, so a room created before this feature existed (whose
/// `REMAINING_TILES` prefix is entirely empty) reads as a full tray rather
/// than an instantly-exhausted one, which would have silently frozen every
/// tile lay in every pre-existing room. A `tile_id` that isn't in the
/// catalog at all reads as `0`; `execute_lay_tile` rejects it earlier with
/// `TileNotFound` regardless.
pub fn remaining_tile_count(
    storage: &dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> StdResult<u32> {
    Ok(REMAINING_TILES
        .may_load(storage, (game_id, tile_id))?
        .unwrap_or_else(|| tile_starting_quantity(tile_id).unwrap_or(0)))
}

/// Whether `tile_id` is exempt from depletion -- see
/// `UNLIMITED_TILE_SUPPLY`. Checked against the LIVE tray count rather than
/// the catalog, so the exemption survives `gamelog::reapply_game_log`'s
/// reset and any future per-room override.
fn tile_supply_is_unlimited(remaining: u32) -> bool {
    remaining == UNLIMITED_TILE_SUPPLY
}

/// Removes one copy of `tile_id` from `game_id`'s tray, erroring with
/// `TileSupplyExhausted` if none remain. A no-op for an unlimited entry.
///
/// Callers must have already validated that `tile_id` exists in the
/// catalog.
fn consume_tile_from_tray(
    storage: &mut dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> Result<(), HexMapError> {
    let remaining = remaining_tile_count(storage, game_id, tile_id)?;
    if tile_supply_is_unlimited(remaining) {
        return Ok(());
    }
    if remaining == 0 {
        return Err(HexMapError::TileSupplyExhausted {
            game_id,
            tile_id,
            starting_quantity: tile_starting_quantity(tile_id).unwrap_or(0),
        });
    }
    REMAINING_TILES.save(storage, (game_id, tile_id), &(remaining - 1))?;
    Ok(())
}

/// Returns one copy of `tile_id` to `game_id`'s tray -- the real 1830
/// recycling rule: the tile you LIFT OFF the board during a colour upgrade
/// goes back into the supply, where any company may lay it again later. A
/// no-op for an unlimited entry.
///
/// Saturates at `u32::MAX - 1` rather than wrapping, so a pathological
/// sequence can never accidentally land a finite tile on the
/// `UNLIMITED_TILE_SUPPLY` sentinel and silently make it infinite.
fn return_tile_to_tray(
    storage: &mut dyn Storage,
    game_id: u64,
    tile_id: u32,
) -> StdResult<()> {
    let remaining = remaining_tile_count(storage, game_id, tile_id)?;
    if tile_supply_is_unlimited(remaining) {
        return Ok(());
    }
    let restored = remaining.saturating_add(1).min(UNLIMITED_TILE_SUPPLY - 1);
    REMAINING_TILES.save(storage, (game_id, tile_id), &restored)?;
    Ok(())
}

/// The next `TileColor` tier directly above `color` in the classic 1830
/// progression, or `None` if `color` is already the top (`Brown`) tier with
/// nowhere further to upgrade. See module doc comment #10.
fn next_tile_color(color: TileColor) -> Option<TileColor> {
    match color {
        TileColor::Yellow => Some(TileColor::Green),
        TileColor::Green => Some(TileColor::Brown),
        TileColor::Brown => None,
    }
}

/// Axial-coordinate neighbor offsets, indexed by edge (0-5). Edge `i` on a
/// tile at `(q, r)` touches the tile at
/// `(q + HEX_NEIGHBOR_OFFSETS[i].0, r + HEX_NEIGHBOR_OFFSETS[i].1)`, on that
/// neighbor's opposite edge `(i + 3) % 6`.
pub const HEX_NEIGHBOR_OFFSETS: [(i32, i32); 6] =
    [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)];

/// Audit G-10: every hex the real 1830 board prints as water/river terrain,
/// carrying an `upgrade=cost:80,terrain:water` build fee.
///
/// Verbatim from `g_1830/map.rb` -- three white water hexes (F4/J14/F22), four
/// blank water hexes (D6/I17/B18/C19), and three PREPRINTED yellow hexes that
/// are also water (E5/D10 OO, and G19 New York). Converted through this file's
/// own `BOARD_HEX_LABELS`.
///
/// NOTE: this comment previously opened with `IMPASSABLE_HEX_EDGES`' own
/// documentation, orphaned here by a refactor that moved that constant ~90
/// lines down without its doc comment. The orphaned text has been returned to
/// the constant it describes.
pub const RIVER_HEXES: &[(&str, i32, i32)] = &[
    ("F4", -1, 5),   // Toledo
    ("J14", 2, 9),   // Washington
    ("F22", 8, 5),   // Providence
    ("D6", 1, 3),    // blank water
    ("I17", 4, 8),   // blank water
    ("B18", 8, 1),   // blank water
    ("C19", 8, 2),   // blank water
    ("E5", 0, 4),    // Detroit & Windsor (OO)
    ("D10", 3, 3),   // Hamilton & Toronto (OO)
    ("G19", 6, 6),   // New York & Newark (NY)
];

/// Audit G-10: every hex the real 1830 board prints as mountain terrain,
/// carrying an `upgrade=cost:120,terrain:mountain` build fee. Same sourcing and
/// conversion as `RIVER_HEXES` -- nine blank mountain hexes, C17 (which also
/// carries an impassable border edge), and F16 Scranton (a mountain hex that is
/// also a city).
pub const MOUNTAIN_HEXES: &[(&str, i32, i32)] = &[
    ("C17", 7, 2),
    ("G15", 4, 6),
    ("C21", 9, 2),
    ("D22", 9, 3),
    ("E17", 6, 4),
    ("E21", 8, 4),
    ("G13", 3, 6),
    ("I11", 1, 8),
    ("J10", 0, 9),
    ("J12", 1, 9),
    ("F16", 5, 5), // Scranton
];

/// The one-time terrain build fee for laying track onto `(q, r)`: $80 river,
/// $120 mountain, $0 clear land.
///
/// Audit G-10. Terrain cost is a property of the HEX, printed on the board, and
/// is paid once when that hex is first built on -- regardless of which artwork
/// is laid. It previously lived on `TILE_CATALOG` as a per-tile `cost`, which
/// produced two exploits: laying an ordinary plain tile onto a genuine river or
/// mountain hex was FREE, while laying the invented "mountain pass" artwork
/// onto flat grassland charged $80 for nothing.
///
/// Figures match `g_1830/map.rb`'s own `upgrade=cost:` values and the
/// frontend's `TERRAIN_BUILD_COST_LABEL`, so what a player is shown is what the
/// contract charges. A hex is never both; river is checked first regardless, so
/// the function is total.
pub fn terrain_build_fee(q: i32, r: i32) -> Uint128 {
    if RIVER_HEXES.iter().any(|(_, hq, hr)| *hq == q && *hr == r) {
        return Uint128::new(RIVER_BUILD_FEE);
    }
    if MOUNTAIN_HEXES.iter().any(|(_, hq, hr)| *hq == q && *hr == r) {
        return Uint128::new(MOUNTAIN_BUILD_FEE);
    }
    Uint128::zero()
}

/// Real 1830's printed water/river build fee.
pub const RIVER_BUILD_FEE: u128 = 80;

/// Real 1830's printed mountain build fee.
pub const MOUNTAIN_BUILD_FEE: u128 = 120;

/// Fixed set of board-edge crossings across which track may never be built
/// (module doc comment #22). Each entry is `(q, r, edge)`: that hex's `edge`
/// may never appear in a laid tile's rotated `connections`.
///
/// Listed as SYMMETRIC pairs -- both hexes on either side of a border carry
/// their own entry for their own facing edge -- so `impassable_edge_mask`
/// closes the border from whichever side a player tries to route across it.
///
/// Coordinates come from this file's own `BOARD_HEX_LABELS`; edges were derived
/// from `HEX_NEIGHBOR_OFFSETS`' axial deltas (E7 `(1, 4)` -> F8 `(1, 5)` is
/// delta `(0, 1)`, index 5, so E7's entry is edge 5 and F8's reciprocal is
/// `(5 + 3) % 6 = 2`).
///
/// A custom board-geometry restriction specified for this engine, NOT sourced
/// from the real 1830 rulebook -- unlike this file's other terrain facts, it
/// has no source to check against.
///
/// (This doc comment was orphaned onto `RIVER_HEXES` by a refactor that moved
/// the constant without it; restored here.)
pub const IMPASSABLE_HEX_EDGES: &[(i32, i32, u8)] = &[
    // E7 (London) / F8 border.
    (1, 4, 5), // E7, edge 5 (toward F8)
    (1, 5, 2), // F8, edge 2 (toward E7)
    // D12 / C11 border.
    (4, 3, 2), // D12, edge 2 (toward C11)
    (4, 2, 5), // C11, edge 5 (toward D12)
    // D12 / C13 border.
    (4, 3, 1), // D12, edge 1 (toward C13)
    (5, 2, 4), // C13, edge 4 (toward D12)
    // C17 / B16 (Ottawa) border.
    (7, 2, 2), // C17, edge 2 (toward B16)
    (7, 1, 5), // B16, edge 5 (toward C17)
];

/// Returns a bitmask (bit `i` set means edge `i` is blocked) of every edge
/// `IMPASSABLE_HEX_EDGES` lists for hex `(q, r)` -- `0` if the hex has no
/// impassable border at all (true for the overwhelming majority of the
/// board). `execute_lay_tile` and `legal_tile_placements` both AND this
/// against a candidate placement's own rotated `connections` to reject any
/// orientation that would leave a live edge on a blocked crossing.
pub(crate) fn impassable_edge_mask(q: i32, r: i32) -> u8 {
    IMPASSABLE_HEX_EDGES
        .iter()
        .filter(|(eq, er, _)| *eq == q && *er == r)
        .fold(0u8, |mask, (_, _, edge)| mask | (1u8 << *edge))
}

#[derive(Error, Debug)]
pub enum HexMapError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    /// Audit G-5: the physical tray has run out of this tile artwork. Real
    /// 1830 ships a finite number of copies of every tile, and running the
    /// supply dry is a genuine, frequently decisive strategic constraint --
    /// not an edge case.
    #[error(
        "Tile {tile_id} is exhausted in game room {game_id}: every one of its {starting_quantity} physical copies is already on the board"
    )]
    TileSupplyExhausted {
        game_id: u64,
        tile_id: u32,
        starting_quantity: u32,
    },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Public company {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error("Public company {company_id} has not floated yet and cannot lay track")]
    CompanyNotFloated { company_id: u32 },

    #[error(
        "Protocol {protocol_id} has no registered President; someone must hold a qualifying stake before tiles can be laid on its behalf"
    )]
    NoPresidentAssigned { protocol_id: u32 },

    #[error(
        "Unauthorized: only protocol {protocol_id}'s registered President may lay tiles for it"
    )]
    NotPresident { protocol_id: u32 },

    #[error(
        "It is not protocol {protocol_id}'s turn in game room {game_id}'s Operating Round Corporation Turn Queue; protocol {expected_protocol_id} must act first"
    )]
    NotYourOperatingTurn {
        game_id: u64,
        protocol_id: u32,
        expected_protocol_id: u32,
    },

    #[error("No tile artwork with id {tile_id} exists in the tile catalog")]
    TileNotFound { tile_id: u32 },

    #[error(
        "Orientation {orientation} is out of range; a tile's rotation must be a number of 60-degree steps between 0 and 5 inclusive"
    )]
    InvalidOrientation { orientation: u32 },

    #[error(
        "Tile {tile_id} is {tile_color:?}, but game room {game_id}'s current Tech Era only has up through {current_era:?} unlocked"
    )]
    EraLocked {
        game_id: u64,
        tile_id: u32,
        tile_color: TileColor,
        current_era: TileColor,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {landmark} preprinted City hex, which only accepts its designated multi-city hub tile artwork, not tile {tile_id}"
    )]
    LandmarkRequiresHubTile {
        /// The landmark's or `CITY_DESIGNATED_HEXES` entry's display name --
        /// module doc comment #16 generalized this check (and this field's
        /// meaning) from landmarks-only to every preprinted City hex.
        landmark: String,
        q: i32,
        r: i32,
        /// The real 1830 board label this coordinate resolves to (e.g.
        /// `"G19"`) -- see `describe_hex`. Coordinate Symmetries: every
        /// `HexMapError` variant that carries `(q, r)` also carries this,
        /// so nothing surfaced to a caller ever requires hand-computing the
        /// axial transform to check against the physical board.
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a major city hub, which can only be laid at one of the reserved City hexes (a landmark or a preprinted gray city), not {hex_label} ({q}, {r})"
    )]
    HubTileMustBeOnLandmark {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {oo_hex_name} preprinted OO double-city hex, which only accepts its designated double-city hub tile artwork, not tile {tile_id}"
    )]
    OOHexRequiresDoubleCityHubTile {
        /// `OO_DESIGNATED_HEXES`' entry's display name -- module doc comment
        /// #18 (OO Double-City Tile Catalog Enforcement).
        oo_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a double-city hub, which can only be laid at one of the four reserved OO hexes, not {hex_label} ({q}, {r})"
    )]
    DoubleCityHubTileMustBeOnOOHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is {b_hex_name}, a preprinted \"B\"-labeled City hex, whose Green- or Brown-tier upgrade only accepts its designated B-labeled tile artwork, not tile {tile_id}"
    )]
    // Renamed from `BostonHexRequiresBostonHubTile` (module doc comment #27): the
    // message hardcoded "Boston", which became wrong once Baltimore was added as a
    // second "B"-labeled hex. `b_hex_name` now names whichever was involved.
    BHexRequiresBHubTile {
        b_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is the \"B\"-labeled hub tile, which can only be laid at a \"B\"-labeled hex (Boston or Baltimore), not {hex_label} ({q}, {r})"
    )]
    // Renamed from `BostonHubTileMustBeOnBostonHex` (module doc comment
    // #27), same "Boston" hardcoding fix as `BHexRequiresBHubTile` above.
    BHubTileMustBeOnBHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is New York, the preprinted \"NY\"-labeled City hex, whose Green- or Brown-tier upgrade only accepts its designated NY-labeled double-city tile artwork, not tile {tile_id}"
    )]
    NewYorkHexRequiresNewYorkHubTile {
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is the \"NY\"-labeled New York hub tile, which can only be laid at New York, not {hex_label} ({q}, {r})"
    )]
    NewYorkHubTileMustBeOnNewYorkHex {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {gray_hex_name} preprinted GRAY hex, whose real starting track is permanent -- it never accepts any laid tile artwork (including tile {tile_id}), unlike a Yellow pre-printed landmark or OO hex"
    )]
    GrayHexNotUpgradeable {
        /// `GRAY_PREPRINTED_HEXES`' entry's display name -- module doc
        /// comment #19 (Gray Hex Immutability).
        gray_hex_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} at orientation {orientation} would route track across edge {edge} of {hex_label} ({q}, {r}), which lies on a permanently impassable border -- the hex may still receive a tile, just not one oriented to carry track across that specific edge"
    )]
    TrackCrossesImpassableEdge {
        /// `IMPASSABLE_HEX_EDGES`' 0-5 edge index (module doc comment #22).
        edge: u8,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
        orientation: u8,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {town_name} preprinted {designation} hex, which only accepts a Single/Double-Town tile artwork, not tile {tile_id}"
    )]
    TownDesignationRequiresTownTile {
        town_name: String,
        /// `"Double-Town"` if the hex is one of `TOWN_DESIGNATED_HEXES`'s
        /// double-town entries, else `"Single-Town"` -- module doc comment
        /// #16.
        designation: &'static str,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} is a Single/Double-Town tile, which can only be laid at one of the reserved Town/Double-Town hexes, not {hex_label} ({q}, {r})"
    )]
    TownTileMustBeOnTownDesignation {
        tile_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "{hex_label} ({q}, {r}) is the {offboard_name} off-board revenue terminal, which never accepts any laid tile artwork (including tile {tile_id})"
    )]
    OffboardHexNotBuildable {
        offboard_name: String,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "The tile already at {hex_label} ({q}, {r}) is Brown, the top color tier -- it has no further upgrade"
    )]
    AlreadyMaxColor { q: i32, r: i32, hex_label: String },

    #[error(
        "{hex_label} ({q}, {r})'s existing tile is {old_color:?}; upgrading it requires a {expected_color:?} tile, not a {attempted_color:?} one"
    )]
    InvalidColorUpgrade {
        q: i32,
        r: i32,
        hex_label: String,
        old_color: TileColor,
        attempted_color: TileColor,
        expected_color: TileColor,
    },

    #[error(
        "No rotation of tile {tile_id} preserves every track connection already on the existing tile at {hex_label} ({q}, {r}); an upgrade can never delete or disconnect existing paths"
    )]
    TopologyNotPreserved {
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error(
        "Tile {tile_id} cannot legally connect to protocol {protocol_id}'s Token Station (Node) network at any rotation from {hex_label} ({q}, {r})"
    )]
    NoLegalConnection {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
        tile_id: u32,
    },

    #[error("Protocol {company_id}'s treasury holds {available} VGP, which is less than the {required} VGP terrain cost")]
    InsufficientTreasury {
        company_id: u32,
        required: Uint128,
        available: Uint128,
    },

    #[error("Arithmetic overflow/underflow while processing a tile placement")]
    Overflow {},

    // ---- Station Tokens (module doc comment #23) ----
    #[error(
        "{hex_label} ({q}, {r}) has no laid MajorCityHub/DoubleCityHub tile yet -- a Station Token can only be placed on an actual city"
    )]
    StationTokenHexNotACity { q: i32, r: i32, hex_label: String },

    #[error(
        "{hex_label} ({q}, {r}) isn't reachable from protocol {protocol_id}'s own track network yet -- a Station Token can only be placed at a city that protocol's own laid track already reaches"
    )]
    StationTokenHexNotReachable {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "Protocol {protocol_id} already has a Station Token on {hex_label} ({q}, {r}) -- a corporation may never place two of its own tokens on the same hex"
    )]
    StationTokenAlreadyOnHex {
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },

    #[error(
        "Protocol {protocol_id} already has all {limit} of its Station Tokens placed -- no more may be placed this game"
    )]
    StationTokenLimitReached { protocol_id: u32, limit: u8 },
    /// Audit G-14: this action was attempted outside its Operating Round
    /// sub-phase. The turn runs BuyPrivate -> Track -> Tokens -> Routes ->
    /// Dividends -> Hardware, and the check is strict equality -- being PAST
    /// a phase fails as loudly as being before it, because reordering after
    /// the fact is exactly what this prevents.
    #[error(
        "protocol {protocol_id} is in Operating Round phase {actual} (step {actual_index} of 6); this action requires phase {required} (step {required_index} of 6)"
    )]
    WrongOperatingSubPhase {
        protocol_id: u32,
        actual: String,
        actual_index: u8,
        required: String,
        required_index: u8,
    },
    /// Audit G-12: the requested `city_index` does not exist on this hex --
    /// e.g. city 1 on a single-city tile. Distinguished from
    /// `StationTokenCityFull` on purpose: one is a malformed request, the
    /// other a legal request the board refuses.
    #[error("hex ({q}, {r}) [{hex_label}] has {city_count} city/cities; city_index {requested} does not exist")]
    StationTokenCityIndexOutOfRange {
        q: i32,
        r: i32,
        hex_label: String,
        requested: u8,
        city_count: u8,
    },
    /// Audit G-12: every slot in the requested city is already taken. When no
    /// `city_index` was supplied this means EVERY city on the hex is full.
    #[error("city {city_index} on hex ({q}, {r}) [{hex_label}] is full ({slots} slot(s))")]
    StationTokenCityFull {
        q: i32,
        r: i32,
        hex_label: String,
        city_index: u8,
        slots: u32,
    },

    #[error(
        "Protocol {protocol_id} already placed a Station Token during this Operating Round sub-round (macro round {macro_round_number}, sub-round {sub_round_index}) -- only one Station Token placement is allowed per corporation per sub-round"
    )]
    StationTokenAlreadyPlacedThisSubRound {
        protocol_id: u32,
        macro_round_number: u32,
        sub_round_index: u32,
    },

    #[error(
        "Protocol {company_id}'s treasury holds {available} VGP, which is less than the {required} VGP Station Token cost"
    )]
    InsufficientTreasuryForStationToken {
        company_id: u32,
        required: Uint128,
        available: Uint128,
    },

    // ---- Private-Company-Reserved Hexes (module doc comment #24) ----
    #[error(
        "{hex_label} ({q}, {r}) is reserved for private company id {private_id} -- only the corporation that owns that private company's wrapper (via owner_protocol_id, not a mere player owner) may lay track here, and protocol {protocol_id} does not own it"
    )]
    HexReservedForUnownedPrivate {
        private_id: u32,
        protocol_id: u32,
        q: i32,
        r: i32,
        hex_label: String,
    },
}

/// Rotates a six-edge connection bitmask by `orientation` steps (0-5),
/// treating the six bits as a circular ring. `pub(crate)` since
/// `pathfinding.rs`'s route-tracing engine needs the same rotation logic to
/// read a laid `Tile`'s actual on-map edges.
pub(crate) fn rotate_connections(mask: u8, orientation: u8) -> u8 {
    let orientation = orientation % 6;
    let mask = mask & 0b0011_1111;
    if orientation == 0 {
        return mask;
    }
    ((mask << orientation) | (mask >> (6 - orientation))) & 0b0011_1111
}

/* ------------------------------------------------------------------ */
/* Edge-to-Edge Path Geometry (Audit G-9)                             */
/* ------------------------------------------------------------------ */

/// Rotates a single base edge index by `orientation` sixths of a turn --
/// the per-edge scalar equivalent of `rotate_connections`' whole-mask
/// circular shift, and the primitive `rotate_paths` below is built from.
///
/// Both operands are reduced mod 6 before adding, so this is total for every
/// `u8` input and can never overflow -- the same defensiveness
/// `rotate_connections` gets from masking to six bits first.
pub(crate) fn rotate_edge(edge: u8, orientation: u8) -> u8 {
    ((edge % 6) + (orientation % 6)) % 6
}

/// Rotates a tile's base edge-pair list into its actual on-map segments (Audit
/// G-9), re-normalized to `(min, max)` so a segment has one canonical spelling
/// regardless of traversal direction. A terminal spur `(a, a)` stays a spur
/// under rotation.
///
/// Deliberately mirrors `rotate_connections` exactly: `Tile::paths` and
/// `Tile::connections` are both stored pre-rotation, so both must be rotated at
/// read time and can never drift apart.
/// The edge index on hex `from` facing hex `to`, or `None` when they are not
/// adjacent (Audit G-13). The inverse of `HEX_NEIGHBOR_OFFSETS`, which this
/// SEARCHES rather than re-deriving with its own arithmetic, so the two
/// directions of the same mapping cannot drift apart.
///
/// Added for `operations::execute_run_manual_route`: a declared `hex_path` pins
/// each interior hex's inbound and outbound edges by its axial deltas.
pub fn edge_between(from: (i32, i32), to: (i32, i32)) -> Option<u8> {
    let delta = (to.0 - from.0, to.1 - from.1);
    HEX_NEIGHBOR_OFFSETS
        .iter()
        .position(|&(dq, dr)| (dq, dr) == delta)
        .and_then(|index| u8::try_from(index).ok())
}

pub(crate) fn rotate_paths(paths: &[(u8, u8)], orientation: u8) -> Vec<(u8, u8)> {
    paths
        .iter()
        .map(|&(a, b)| normalize_path(rotate_edge(a, orientation), rotate_edge(b, orientation)))
        .collect()
}

/// Canonical `(min, max)` spelling of an edge pair -- the single form both
/// `TILE_CATALOG` and `pathfinding.rs`'s claimed-segment ledger use, so
/// traversing a segment `a -> b` and `b -> a` claims the same ledger key.
pub(crate) fn normalize_path(a: u8, b: u8) -> (u8, u8) {
    if a <= b {
        (a, b)
    } else {
        (b, a)
    }
}

/// Looks up `tile_id`'s *base* (pre-rotation) edge-pair list from
/// `TILE_CATALOG`, or `None` if no such tile exists (Audit G-9).
pub fn tile_paths_for(tile_id: u32) -> Option<&'static [(u8, u8)]> {
    TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, _, _, _terrain, _color, _qty, paths, _revenue)| paths)
}

/// Re-derives `tile_id`'s flat connection bitmask from its edge-pair list --
/// the union of every edge appearing in any of its segments, terminal spurs
/// included. `None` if no such tile exists.
///
/// This is the machine-checkable half of `TILE_CATALOG`'s stated invariant
/// (`connections == tile_base_connections(tile_id)` for every entry). It is
/// not used on the hot path -- the stored mask is -- it exists so the test
/// suite can prove the two fields never disagree, which is what stops a
/// future hand-edit of one from silently desynchronizing the other.
pub fn tile_base_connections(tile_id: u32) -> Option<u8> {
    tile_paths_for(tile_id).map(path_list_connections)
}

/// The union bitmask of every edge touched by `paths`.
pub(crate) fn path_list_connections(paths: &[(u8, u8)]) -> u8 {
    paths.iter().fold(0u8, |mask, &(a, b)| {
        mask | (1u8 << (a % 6)) | (1u8 << (b % 6))
    })
}

/// The rotated edge-pair segments actually in play on `tile` (Audit G-9).
///
/// Prefers the tile's own stored `paths`, falling back to `TILE_CATALOG`. The
/// fallback is NOT dead code: `Tile::paths` is `#[serde(default)]`, so any tile
/// written before G-9 deserializes with an empty list and would otherwise
/// become permanently unroutable -- a silent board-wide dead zone of exactly
/// the kind module doc comment #20 had to fix once already.
///
/// Empty `Vec` for a `tile_id` not in the catalog -- unreachable through
/// `execute_lay_tile`, but total by construction rather than by assumption.
pub(crate) fn effective_tile_paths(tile: &Tile) -> Vec<(u8, u8)> {
    rotate_paths(effective_base_tile_paths(tile), tile.orientation)
}

/// `effective_tile_paths` without the rotation step: the BASE (pre-rotation)
/// segments actually in play on `tile`, stored list preferred and
/// `TILE_CATALOG` used as the same backwards-compatibility fallback (see
/// that function for why the fallback is load-bearing rather than dead).
///
/// Split out for `query::query_map_grid`, which surfaces these on
/// `msg::MapTileEntry::paths`. That response reports `orientation` as its
/// own separate field and states edges pre-rotation -- matching the
/// convention `connections` has always used -- so the caller applies the
/// rotation itself and this must hand back base edges, not rotated ones.
/// Routing code inside the contract wants the rotated form and should keep
/// calling `effective_tile_paths`.
pub(crate) fn effective_base_tile_paths(tile: &Tile) -> &[(u8, u8)] {
    if tile.paths.is_empty() {
        tile_paths_for(tile.tile_id).unwrap_or(&[])
    } else {
        &tile.paths
    }
}

/// How many Station Token slots the city artwork on `tile_id` provides, or 0
/// for a tile with no city (plain track and towns -- a town is a revenue stop
/// but never holds a token).
///
/// Audit G-9, feeding the rival-blockade rule: a route may not pass THROUGH a
/// city whose every slot is taken by rivals, but may always pass through one
/// with an open slot. Figures are the `slots:` counts in `config/tile.rb`.
pub fn tile_city_slots(tile_id: u32) -> u32 {
    // Audit G-12: derived from `tile_city_slot_counts` rather than restated,
    // so the total and the per-city breakdown cannot disagree. Values are
    // unchanged from the hand-written table this replaced.
    tile_city_slot_counts(tile_id).iter().sum()
}

/// How many Station Token slots EACH city on `tile_id` offers, one entry per
/// city, in the SAME index order as the tile's path list and the frontend's
/// `TILE_GRAPHICS_CATALOG` markers -- so a `city_index` means the same city
/// everywhere it appears.
///
/// Audit G-12, from each tile's own `slots:` field:
///
///   #53/#57/#61      no `slots:` -- one 1-slot city. #61, the BROWN "B" hub,
///                    really is 1-slot; its importance invites the assumption
///                    that it is 2, and it is not.
///   #14/#15/#63      `slots:2` -- one 2-slot city.
///   #54/#59/#64-#68  two `city=` entries, neither with `slots:` -- TWO
///                    separate 1-slot cities. Green New York (#54) included.
///   #62              two `slots:2` cities -- the only tile in 1830 shaped that
///                    way, and the one that makes pooled per-hex slot counting
///                    unsalvageable.
///
/// Empty for a tile with no city, which is the signal that nothing can be
/// tokened or blockaded there.
pub fn tile_city_slot_counts(tile_id: u32) -> &'static [u32] {
    match tile_id {
        53 | 57 | 61 => &[1],
        14 | 15 | 63 => &[2],
        54 | 59 | 64 | 65 | 66 | 67 | 68 => &[1, 1],
        62 => &[2, 2],
        _ => &[],
    }
}

/// How many Station Token slots hex `(q, r)` offers with NO tile laid -- the
/// preprinted counterpart to `tile_city_slots`.
///
/// New York prints two one-slot cities, so 2; the four OO hexes likewise 2;
/// Boston, Baltimore and every `CITY_DESIGNATED_HEXES` entry print one, so 1.
///
/// The six gray cities matter most here: module doc comment #19 made them
/// permanently un-layable, so `MAP_GRID` never holds a `Tile` there and this
/// lookup is the ONLY source of their slot count, forever.
///
/// A preprinted TOWN, a bare gray connector, an off-board terminal or an
/// ordinary blank hex has no slot and can never be blockaded.
pub fn preprinted_city_slots(q: i32, r: i32) -> u32 {
    // Audit G-12: derived, not restated -- see `tile_city_slots`.
    preprinted_city_slot_counts(q, r).iter().sum()
}

/// The per-city counterpart to `preprinted_city_slot_counts`' totals (Audit
/// G-12).
///
/// New York and the four OO hexes print TWO cities of one slot each, not one
/// city of two slots, and that difference is exactly the bug this exists for:
/// two rivals tokening New York fill both of its cities, whereas the pooled
/// reading saw "2 of 2" only once both happened to land on the same hex
/// regardless of which city each took.
pub fn preprinted_city_slot_counts(q: i32, r: i32) -> &'static [u32] {
    if landmark_name_at(q, r) == Some("New York") || oo_designation_name_at(q, r).is_some() {
        return &[1, 1];
    }
    if landmark_name_at(q, r).is_some() || city_designation_name_at(q, r).is_some() {
        return &[1];
    }
    &[]
}

/// WHICH city each of `tile_id`'s track segments runs through, one entry per
/// segment, parallel to `tile_paths_for(tile_id)` and to the rotated list.
///
/// Audit G-13: this is what makes a blockade check city-granular instead of
/// hex-granular. Without it the engine can tell that SOME city on a hex is open
/// but not WHICH, so a route could enter through a fully-tokened city's track
/// and leave through it again -- "ghost routing" straight past a blockade that
/// in real 1830 is the whole point of having placed those tokens.
///
/// `Some(i)` -- this segment passes through city `i`.
///
/// `None` -- one of two very different situations, which the caller MUST
/// distinguish by checking whether the hex has any cities at all: the tile
/// genuinely has no city (nothing can block it), or the segment list does not
/// line up with the city list (today, a synthesized overlay tile). A caller
/// that finds `None` on a hex that DOES have cities must fall back to the
/// STRICTEST city's answer, never the most permissive one -- guessing
/// permissively is exactly the ghost route this exists to stop.
///
/// The one-segment-per-city index correspondence is the load-bearing claim and
/// is asserted for every multi-city tile by
/// `tile_segment_cities_agree_with_catalog_path_counts`, so a catalog edit that
/// breaks it fails the suite rather than silently reintroducing ghost routing.
/// Per-tile derivations are in rust_contract_architecture.md.
///
/// `segment_count` is passed rather than read from the catalog because the
/// caller may be working from a `Tile`'s OWN stored `paths`; a length mismatch
/// means the correspondence cannot be trusted and every entry comes back
/// `None` -- conservative by construction.
pub fn tile_segment_cities(tile_id: u32, segment_count: usize) -> Vec<Option<u8>> {
    let cities = tile_city_slot_counts(tile_id).len();
    match cities {
        // No city on this tile -- nothing here can ever be blockaded.
        0 => vec![None; segment_count],
        // One city, and every segment on the tile runs through it: the
        // multi-spoke city hubs (#14/#15/#53/#61/#63) and the single
        // straight-through city (#57).
        1 => vec![Some(0); segment_count],
        // One segment per city, in city order.
        n if n == segment_count => (0..segment_count).map(|i| u8::try_from(i).ok()).collect(),
        // Shape we cannot interpret -- see the `None` discussion above.
        _ => vec![None; segment_count],
    }
}

/// Every city on hex `(q, r)` and its slot count -- the laid tile's own
/// breakdown if a tile is there, otherwise the preprinted artwork's.
/// Empty means the hex has no city, so it can never be tokened or blockaded.
pub fn city_slot_counts_at(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<&'static [u32], StdError> {
    if let Some(tile) = MAP_GRID.may_load(storage, (game_id, q, r))? {
        return Ok(tile_city_slot_counts(tile.tile_id));
    }
    Ok(preprinted_city_slot_counts(q, r))
}

/// Every Station Token on hex `(q, r)` as `(protocol_id, city_index)` -- Audit
/// G-12, and the single read path for token occupancy.
///
/// Reads `HEX_STATION_TOKENS`, then RECONSTRUCTS anything that map does not
/// know about from `PROTOCOL_STATION_HEXES` at `city_index` 0. That backfill is
/// what makes G-12 safe to deploy over a game in progress: pre-G-12 tokens
/// exist only in the hex-keyed list, and dropping them would delete live
/// blockades mid-game. City 0 is the honest reconstruction -- precisely the
/// assumption the pre-G-12 code made, and exactly right for every single-city
/// hex, which is most of the board.
///
/// Idempotent: a company already in `HEX_STATION_TOKENS` is never added twice.
pub fn hex_token_occupants(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<Vec<(u32, u8)>, StdError> {
    let mut occupants: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(storage, (game_id, q, r))?
        .unwrap_or_default();
    for (company_id, _) in CORE_PUBLIC_COMPANIES.iter().copied() {
        if occupants.iter().any(|(id, _)| *id == company_id) {
            continue;
        }
        let hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
            .may_load(storage, (game_id, company_id))?
            .unwrap_or_default();
        if hexes.contains(&(q, r)) {
            occupants.push((company_id, 0));
        }
    }
    Ok(occupants)
}

/// How many tokens sit in city `city_index` on this hex.
pub fn city_occupancy(occupants: &[(u32, u8)], city_index: u8) -> u32 {
    occupants
        .iter()
        .filter(|(_, city)| *city == city_index)
        .count() as u32
}

/// The lowest-indexed city on this hex that still has a free slot, or `None`
/// if every city is full. Used to resolve a `PlaceStationToken` that does not
/// name a city, which keeps the message backwards compatible: a client that
/// predates `city_index` still lands somewhere legal rather than being
/// rejected, and on a single-city hex "somewhere legal" is the only city.
pub fn first_open_city(slot_counts: &[u32], occupants: &[(u32, u8)]) -> Option<u8> {
    slot_counts.iter().enumerate().find_map(|(index, capacity)| {
        let city_index = u8::try_from(index).ok()?;
        (city_occupancy(occupants, city_index) < *capacity).then_some(city_index)
    })
}

/// Breadth-first-walks `protocol_id`'s laid tiles outward from its Token
/// Station (Node) -- `PROTOCOL_NETWORK_HEXES`'s first entry -- following
/// only edges that are actually live (post-rotation) on both sides of each
/// hop, and returns every hex reached (the station itself included), along
/// with the station's own coordinates if one exists yet. See module doc
/// comment #9 for why this is recomputed fresh from the live `MAP_GRID`
/// board on every call rather than trusted from history.
fn station_reachable_hexes(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Option<(i32, i32)>, HashSet<(i32, i32)>), HexMapError> {
    let network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let station = match network_hexes.first() {
        Some(home) => *home,
        None => return Ok((None, HashSet::new())),
    };

    let mut visited: HashSet<(i32, i32)> = HashSet::from([station]);
    let mut queue: VecDeque<(i32, i32)> = VecDeque::from([station]);

    while let Some(current) = queue.pop_front() {
        let current_tile: Option<Tile> =
            MAP_GRID.may_load(storage, (game_id, current.0, current.1))?;
        let Some(current_tile) = current_tile else {
            continue;
        };
        let current_actual = rotate_connections(current_tile.connections, current_tile.orientation);

        for edge in 0..6u8 {
            if current_actual & (1u8 << edge) == 0 {
                continue;
            }
            let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
            let neighbor = (current.0 + dq, current.1 + dr);
            if visited.contains(&neighbor) {
                continue;
            }

            let neighbor_tile: Option<Tile> =
                MAP_GRID.may_load(storage, (game_id, neighbor.0, neighbor.1))?;
            let Some(neighbor_tile) = neighbor_tile else {
                continue;
            };
            let neighbor_actual =
                rotate_connections(neighbor_tile.connections, neighbor_tile.orientation);
            let opposite_edge = (edge + 3) % 6;
            if neighbor_actual & (1u8 << opposite_edge) == 0 {
                continue;
            }

            visited.insert(neighbor);
            queue.push_back(neighbor);
        }
    }

    Ok((Some(station), visited))
}

/// Tests every `TILE_CATALOG` entry across all six rotations against the same
/// placement rules `execute_lay_tile` enforces, and returns every legal
/// `(tile_id, orientation)` pairing. Backs `QueryMsg::GetLegalTilePlacements`.
///
/// Read-only: takes `&dyn Storage`, and never charges a treasury, checks
/// President authorization or Operating Round turn position.
///
/// MAINTENANCE NOTE: these checks are INDEPENDENT implementations of the same
/// rules, not a shared helper the two call into, so any change to one must be
/// mirrored in the other or this query starts disagreeing with what `LayTile`
/// accepts. That has already happened twice -- see
/// rust_contract_architecture.md.
pub fn legal_tile_placements(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
) -> Result<Vec<(u32, u8)>, HexMapError> {
    let session: GameSession = SESSIONS
        .may_load(storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;

    // Off-Board Reservation (module doc comment #14): an off-board hex
    // accepts no tile artwork at all -- mirrors execute_lay_tile's own
    // unconditional rejection, checked first since it's disjoint from every
    // other rule below.
    if offboard_name_at(q, r).is_some() {
        return Ok(Vec::new());
    }

    // Gray Hex Immutability (module doc comment #19): a preprinted GRAY
    // hex's real starting track is permanent -- mirrors execute_lay_tile's
    // own unconditional rejection, checked right after Off-Board
    // Reservation for the same reason (disjoint from, and more absolute
    // than, every rule below).
    if gray_preprinted_name_at(q, r).is_some() {
        return Ok(Vec::new());
    }

    // Private-Company-Reserved Hexes (module doc comment #24): mirrors
    // execute_lay_tile's own check, per this function's MAINTENANCE NOTE --
    // B20/F16 are blocked unless `protocol_id` owns the matching private
    // company via `owner_protocol_id` (never a mere player `owner`), lifting
    // once that private is `closed`.
    if private_reserved_hex_blocks(storage, game_id, protocol_id, q, r)? {
        return Ok(Vec::new());
    }

    // Impassable Border Edges (module doc comment #22): mirrors
    // `execute_lay_tile`'s own check, per this function's MAINTENANCE NOTE
    // -- computed once here (per-hex, not per-catalog-entry) and ANDed
    // against each candidate orientation's own rotated connections below,
    // in all three placement branches.
    let blocked_edges = impassable_edge_mask(q, r);

    let existing_tile: Option<Tile> = MAP_GRID.may_load(storage, (game_id, q, r))?;
    let landmark = landmark_name_at(q, r);
    let oo_hex = oo_designation_name_at(q, r);
    let plain_city_reserved = city_designation_name_at(q, r);
    let town_designation = town_designation_at(q, r);

    // Topology Retention Upgrade path only (module doc comment #10): precomputed
    // once rather than per catalog entry. `None` means the hex is empty (fresh
    // placement below) or the existing tile is already Brown -- either way no
    // catalog entry can match an upgrade here.
    let upgrade_expected_color = existing_tile
        .as_ref()
        .and_then(|old_tile| tile_color_for(old_tile.tile_id))
        .and_then(next_tile_color);

    // Path Connectivity path only (module doc comment #9): the protocol's
    // current Token Station network, walked once and reused for every
    // catalog/rotation candidate below, exactly mirroring
    // `execute_lay_tile`'s own `station_reachable_hexes` call.
    let (station, reachable) = if existing_tile.is_none() {
        station_reachable_hexes(storage, game_id, protocol_id)?
    } else {
        (None, HashSet::new())
    };

    let mut results = Vec::new();

    for &(tile_id, base_connections, _cost, terrain, new_color, _quantity, _paths, _revenue) in TILE_CATALOG {
        // Tech Era Color-Locking (mirrors execute_lay_tile).
        if new_color > session.current_global_era {
            continue;
        }

        // Tile Inventory Supply Engine (Audit G-5), mirroring `execute_lay_tile`'s own
        // rejection: a tile whose every copy is on the board is not a legal placement.
        //
        // Deliberately the LAST whole-tile disqualifier rather than the first: the
        // era-lock and reservation checks are in-memory comparisons, this one is a
        // storage read. With all 46 tiles in the catalog, running the cheap filters
        // first cuts this query from 46 storage reads to however few are
        // terrain-compatible with the hex -- typically a handful.

        // City Reservation, mirroring `execute_lay_tile` (module doc comment
        // #16/#18/#26/#27): an OO hex requires `DoubleCityHub`, and a "B"/"NY"-labeled
        // hex requires its own dedicated `BostonHub`/`NewYorkHub` terrain. All three
        // are disjoint from the generic landmark/plain-city `MajorCityHub` match below
        // and from each other.
        let is_hub_tile = terrain == TerrainType::MajorCityHub;
        let is_double_city_tile = terrain == TerrainType::DoubleCityHub;
        let is_boston_hub_tile = terrain == TerrainType::BostonHub;
        let is_new_york_hub_tile = terrain == TerrainType::NewYorkHub;
        // Module doc comment #28: the `&& is_upgradeable_tier` guard is REMOVED from
        // the "B"/"NY" branches. Boston, Baltimore and New York are each a
        // corporation's home station and never take a plain Yellow tile in real 1830 --
        // restricting these branches to Green/Brown let the Yellow `MajorCityHub` tile
        // slip through to them via the generic landmark fallback.
        let city_ok = if oo_hex.is_some() {
            is_double_city_tile
        } else if is_double_city_tile {
            false // a double-city tile is illegal anywhere except an OO hex
        } else if is_b_label_hex(landmark) {
            is_boston_hub_tile
        } else if is_boston_hub_tile {
            false // a "B"-labeled hub tile is illegal anywhere but a "B"-labeled hex's own Green/Brown upgrade
        } else if landmark == Some("New York") {
            is_new_york_hub_tile
        } else if is_new_york_hub_tile {
            false // a New York hub tile is illegal anywhere but New York's own Green/Brown upgrade
        } else {
            let city_reserved = landmark.or(plain_city_reserved);
            matches!((city_reserved, is_hub_tile), (Some(_), true) | (None, false))
        };
        if !city_ok {
            continue;
        }

        // Town / Double-Town Reservation (mirrors execute_lay_tile, module
        // doc comment #16).
        let is_town_tile = terrain == TerrainType::SmallTown || terrain == TerrainType::DoubleTown;
        let town_ok = matches!((town_designation, is_town_tile), (Some(_), true) | (None, false));
        if !town_ok {
            continue;
        }

        // Tile Inventory Supply Engine (Audit G-5) -- see the note beside
        // the era gate above for why this storage read sits here, after
        // every cheap in-memory filter, rather than at the top of the loop.
        if remaining_tile_count(storage, game_id, tile_id)? == 0 {
            continue;
        }

        if let Some(old_tile) = &existing_tile {
            // Topology Retention Upgrade (mirrors execute_lay_tile).
            let Some(expected_color) = upgrade_expected_color else {
                continue; // already Brown, or the old tile's own color is unknown
            };
            if new_color != expected_color {
                continue;
            }

            let old_actual = rotate_connections(old_tile.connections, old_tile.orientation);
            for orientation in 0..6u8 {
                let candidate = rotate_connections(base_connections, orientation);
                // old_actual must be a subset of candidate -- no old edge
                // may be missing from the new tile's edge set -- and the
                // candidate itself must not cross an impassable border.
                if old_actual & !candidate == 0 && candidate & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        } else if station.is_none() {
            // A protocol's very first tile ever: unconditionally legal at ANY orientation,
            // mirroring `execute_lay_tile` -- no connectivity check applies to a brand-new
            // Token Station -- unless that orientation would cross an impassable border.
            //
            // BUGFIX: this used to push orientation 0 only, so `GetLegalTilePlacements`
            // was silently hiding five of the six orientations a live `LayTile` call would
            // accept for a protocol's home hex.
            for orientation in 0..6u8 {
                if rotate_connections(base_connections, orientation) & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        } else {
            // Fresh placement onto an already-networked protocol: needs at
            // least one rotation with a live edge that legally reaches the
            // existing network (mirrors execute_lay_tile).
            for orientation in 0..6u8 {
                let actual = rotate_connections(base_connections, orientation);
                let mut connects = false;
                for edge in 0..6u8 {
                    if actual & (1u8 << edge) == 0 {
                        continue;
                    }
                    let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
                    let neighbor = (q + dq, r + dr);
                    if !reachable.contains(&neighbor) {
                        continue;
                    }
                    let neighbor_tile: Option<Tile> =
                        MAP_GRID.may_load(storage, (game_id, neighbor.0, neighbor.1))?;
                    if let Some(neighbor_tile) = neighbor_tile {
                        let neighbor_actual = rotate_connections(
                            neighbor_tile.connections,
                            neighbor_tile.orientation,
                        );
                        let opposite_edge = (edge + 3) % 6;
                        if neighbor_actual & (1u8 << opposite_edge) != 0 {
                            connects = true;
                            break;
                        }
                    }
                }
                // Also mirrors execute_lay_tile's Impassable Border Edges
                // check: a connecting orientation is still illegal if it
                // would carry track across a blocked edge.
                if connects && actual & blocked_edges == 0 {
                    results.push((tile_id, orientation));
                }
            }
        }
    }

    Ok(results)
}

/// Lays `tile_id` at `orientation` at `(q, r)` for `protocol_id` -- onto an
/// empty hex, or as a Topology-Retention Upgrade of the tile there. Requires:
///
/// - `orientation` in `0..=5` (`InvalidOrientation`).
/// - `info.sender` is `protocol_id`'s registered `PROTOCOL_PRESIDENT`.
/// - `protocol_id` is the corporation `active_corporation_index` points to,
///   whenever the room has a non-empty Operating Round Turn Queue.
/// - `protocol_id` has floated and its treasury covers the HEX's terrain fee --
///   a fresh placement only; an upgrade is always free.
/// - the tile's colour is unlocked under `current_global_era`.
/// - the hex's reservation status matches the tile's terrain classification.
/// - empty hex: the tile at exactly the submitted orientation connects, with a
///   verified unbroken path, to the Token Station network -- waived for the
///   protocol's very first tile.
/// - occupied hex: exactly one colour tier up, and the submitted orientation
///   preserves every one of the existing tile's actual edges.
pub fn execute_lay_tile(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
    tile_id: u32,
    orientation: u32,
) -> Result<Response, HexMapError> {
    // Validated first, before any storage access: a pure shape check on the
    // caller's input, independent of game/room state (module doc comment
    // #4). `u8::try_from` also rejects any `orientation` that wouldn't even
    // fit in the six-bit rotation domain `rotate_connections`/`Tile` use
    // internally.
    let orientation: u8 = u8::try_from(orientation)
        .ok()
        .filter(|o| *o < 6)
        .ok_or(HexMapError::InvalidOrientation { orientation })?;

    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HexMapError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HexMapError::NotPresident { protocol_id });
    }

    // Operating Round Corporation Turn Queue (module doc comment #13):
    // layered on top of the President check above, only enforced once the
    // room actually has a non-empty `active_operating_order`.
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(HexMapError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if !company.is_floated {
        return Err(HexMapError::CompanyNotFloated {
            company_id: protocol_id,
        });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Strict equality against the persisted cursor -- see `or_phase`'s module
    // doc for the six-phase order and which phases may be skipped. Being PAST
    // a phase fails as loudly as being before it.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Track,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => HexMapError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => HexMapError::Std(StdError::generic_err(message)),
        });
    }

    // Audit G-10: the catalog's `cost` field is now uniformly `0` and is no
    // longer read here -- a hex's build fee comes from the HEX
    // (`terrain_build_fee`, below), never from the tile artwork laid on it.
    // The field is retained in the tuple only so the catalog's shape stays
    // stable for `query.rs`'s renderer and any future per-tile pricing.
    let (base_connections, terrain, new_color, base_paths) = TILE_CATALOG
        .iter()
        .copied()
        .find(|(id, ..)| *id == tile_id)
        .map(|(_, connections, _cost, terrain, color, _qty, paths, _revenue)| (connections, terrain, color, paths))
        .ok_or(HexMapError::TileNotFound { tile_id })?;

    // Tech Era Color-Locking (module doc comment #8): reject outright if
    // this tile's color tier isn't yet unlocked room-wide, before checking
    // anything else about the placement itself.
    if new_color > session.current_global_era {
        return Err(HexMapError::EraLocked {
            game_id,
            tile_id,
            tile_color: new_color,
            current_era: session.current_global_era,
        });
    }

    // Tile Inventory Supply Engine (Audit G-5): reject a tile whose every copy is
    // on the board, before any geometry is evaluated and long before the treasury
    // is charged. Read-only, purely for clean error ordering and
    // Checks-Effects-Interactions discipline -- the authoritative decrement is
    // `consume_tile_from_tray` below, which re-validates the same condition, and
    // nothing between here and there can change the tray.
    let remaining_before = remaining_tile_count(deps.storage, game_id, tile_id)?;
    if remaining_before == 0 {
        return Err(HexMapError::TileSupplyExhausted {
            game_id,
            tile_id,
            starting_quantity: tile_starting_quantity(tile_id).unwrap_or(0),
        });
    }

    // Off-Board Reservation (module doc comment #14): an off-board hex
    // accepts no tile artwork at all, regardless of terrain type -- checked
    // before Landmark Reservation since the two reserved-hex sets are
    // disjoint and this is the more absolute restriction of the two.
    if let Some(offboard_name) = offboard_name_at(q, r) {
        return Err(HexMapError::OffboardHexNotBuildable {
            offboard_name: offboard_name.to_string(),
            q,
            r,
            hex_label: describe_hex(q, r),
            tile_id,
        });
    }

    // Gray Hex Immutability (module doc comment #19): a preprinted GRAY
    // hex's real starting track is permanent -- nothing may ever be laid
    // here, checked right after Off-Board Reservation for the same reason
    // (disjoint from, and more absolute than, every rule below).
    if let Some(gray_name) = gray_preprinted_name_at(q, r) {
        return Err(HexMapError::GrayHexNotUpgradeable {
            gray_hex_name: gray_name.to_string(),
            q,
            r,
            hex_label: describe_hex(q, r),
            tile_id,
        });
    }

    // Impassable Border Edges (module doc comment #22): checked right after Gray
    // Hex Immutability, for the same reason -- an absolute structural restriction
    // disjoint from the terrain/city/town rules below. Unlike those two, this
    // rejects only the specific candidate orientation, not the whole hex.
    let blocked_edges = impassable_edge_mask(q, r);
    if blocked_edges != 0 {
        let requested_connections = rotate_connections(base_connections, orientation);
        if let Some(edge) = (0..6u8).find(|edge| {
            requested_connections & blocked_edges & (1u8 << *edge) != 0
        }) {
            return Err(HexMapError::TrackCrossesImpassableEdge {
                edge,
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
                orientation,
            });
        }
    }

    // Private-Company-Reserved Hexes (module doc comment #24): B20 and F16 are
    // blocked against any public company unless that company's protocol owns the
    // matching private via `owner_protocol_id` -- never a mere player `owner`.
    // Checked here since it too is an absolute whole-hex restriction. The block
    // lifts once the private is `closed`.
    if private_reserved_hex_blocks(deps.storage, game_id, protocol_id, q, r)? {
        let (hex_label, private_id) = private_reserved_hex_at(q, r)
            .map(|(label, private_id)| (label.to_string(), private_id))
            .unwrap_or_else(|| (describe_hex(q, r), 0));
        return Err(HexMapError::HexReservedForUnownedPrivate {
            private_id,
            protocol_id,
            q,
            r,
            hex_label,
        });
    }

    // City Reservation (module doc comment #11/#16/#18/#26/#27). Checked in the
    // order OO, then "B", then "NY", then the generic landmark/city fallback:
    // each branch's tile-side check would otherwise slip through the next branch
    // down as neither cleanly true nor false. A hub tile of any of these four
    // kinds may only ever be laid at its own matching reserved hex.
    let landmark = landmark_name_at(q, r);
    let oo_hex = oo_designation_name_at(q, r);
    let is_double_city_tile = terrain == TerrainType::DoubleCityHub;
    let is_boston_hub_tile = terrain == TerrainType::BostonHub;
    let is_new_york_hub_tile = terrain == TerrainType::NewYorkHub;
    // Module doc comment #28: the old `is_upgradeable_tier` guard is gone from the
    // "B" and "NY" branches. `legal_tile_placements`' twin change, made here per
    // this function's own MAINTENANCE NOTE.
    if let Some(oo_name) = oo_hex {
        if !is_double_city_tile {
            return Err(HexMapError::OOHexRequiresDoubleCityHubTile {
                oo_hex_name: oo_name.to_string(),
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_double_city_tile {
        return Err(HexMapError::DoubleCityHubTileMustBeOnOOHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else if is_b_label_hex(landmark) {
        // module doc comment #26/#27/#28: a "B"-labeled hex's Yellow, Green,
        // AND Brown tiles are ALL real-1830 label-restricted now (module doc
        // comment #28 removed the old Yellow exemption -- see that note for
        // why the hex's Yellow start does NOT fall through to the ordinary
        // landmark branch below any more).
        if !is_boston_hub_tile {
            return Err(HexMapError::BHexRequiresBHubTile {
                b_hex_name: landmark.unwrap_or_default().to_string(),
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_boston_hub_tile {
        // A `BostonHub` ("B"-label) tile attempted anywhere other than a
        // "B"-labeled hex's own Green/Brown upgrade (including a "B" hex
        // itself at Yellow, where this terrain never legitimately appears
        // in `TILE_CATALOG` at all -- see module doc comment #26/#27).
        return Err(HexMapError::BHubTileMustBeOnBHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else if landmark == Some("New York") {
        // module doc comment #26/#27/#28: same real-1830 "NY"-label
        // restriction, now Yellow-Green-AND-Brown, mirroring the "B" branch
        // immediately above.
        if !is_new_york_hub_tile {
            return Err(HexMapError::NewYorkHexRequiresNewYorkHubTile {
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            });
        }
    } else if is_new_york_hub_tile {
        return Err(HexMapError::NewYorkHubTileMustBeOnNewYorkHex {
            tile_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    } else {
        let city_reserved = landmark.or_else(|| city_designation_name_at(q, r));
        let is_hub_tile = terrain == TerrainType::MajorCityHub;
        match (city_reserved, is_hub_tile) {
            (Some(_), true) | (None, false) => {
                // A reserved City hex getting its designated hub tile -- including a
                // "B"/"NY" hex at Yellow, where the ordinary `MajorCityHub` artwork is still
                // right; that hex's Green and Brown upgrades are intercepted by the dedicated
                // branches above -- or an ordinary hex getting ordinary track. Both legal.
            }
            (Some(name), false) => {
                return Err(HexMapError::LandmarkRequiresHubTile {
                    landmark: name.to_string(),
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    tile_id,
                })
            }
            (None, true) => {
                return Err(HexMapError::HubTileMustBeOnLandmark {
                    tile_id,
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                })
            }
        }
    }

    // Town / Double-Town Reservation (module doc comment #16), symmetric with the
    // City Reservation above. Together the two leave every remaining hex accepting
    // only Plain/MountainRugged track, satisfying the third rule of Rigid On-Chain
    // Tile Matching without a separate check.
    let town_designation = town_designation_at(q, r);
    let is_town_tile = terrain == TerrainType::SmallTown || terrain == TerrainType::DoubleTown;
    match (town_designation, is_town_tile) {
        (Some(_), true) | (None, false) => {
            // A reserved Town/Double-Town hex getting a matching tile, or
            // an ordinary hex getting non-town track -- both legal.
        }
        (Some((name, is_double)), false) => {
            return Err(HexMapError::TownDesignationRequiresTownTile {
                town_name: name.to_string(),
                designation: if is_double { "Double-Town" } else { "Single-Town" },
                q,
                r,
                hex_label: describe_hex(q, r),
                tile_id,
            })
        }
        (None, true) => {
            return Err(HexMapError::TownTileMustBeOnTownDesignation {
                tile_id,
                q,
                r,
                hex_label: describe_hex(q, r),
            })
        }
    }

    let existing_tile: Option<Tile> = MAP_GRID.may_load(deps.storage, (game_id, q, r))?;
    let mut network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default();

    // Enforce Chosen Angle: no rotation search here at all -- only the
    // caller's own submitted `orientation` (already bounds-checked to
    // `0..=5` above) is ever evaluated against the placement's legality
    // rule. See module doc comment #4.
    let is_upgrade = match &existing_tile {
        Some(old_tile) => {
            // Topology Retention Upgrade (module doc comment #10).
            let old_color = tile_color_for(old_tile.tile_id).ok_or(HexMapError::TileNotFound {
                tile_id: old_tile.tile_id,
            })?;
            let expected_color =
                next_tile_color(old_color).ok_or(HexMapError::AlreadyMaxColor {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                })?;
            if new_color != expected_color {
                return Err(HexMapError::InvalidColorUpgrade {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    old_color,
                    attempted_color: new_color,
                    expected_color,
                });
            }

            let old_actual = rotate_connections(old_tile.connections, old_tile.orientation);
            let candidate = rotate_connections(base_connections, orientation);
            // Every bit set in old_actual must also be set in candidate --
            // old_actual is a subset of candidate, i.e. no old edge is
            // missing from the new tile's edge set at the submitted
            // orientation specifically.
            if old_actual & !candidate != 0 {
                return Err(HexMapError::TopologyNotPreserved {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    tile_id,
                });
            }
            true
        }
        None => {
            // Path Connectivity to an existing Token Station (Node)
            // (module doc comment #9).
            let (station, reachable) = station_reachable_hexes(deps.storage, game_id, protocol_id)?;
            if station.is_some() {
                // Not protocol_id's first tile -- the submitted
                // orientation specifically must legally reach the existing
                // network; no other rotation is considered.
                let actual = rotate_connections(base_connections, orientation);
                let mut connects = false;
                for edge in 0..6u8 {
                    if actual & (1u8 << edge) == 0 {
                        continue;
                    }
                    let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
                    let neighbor = (q + dq, r + dr);
                    if !reachable.contains(&neighbor) {
                        continue;
                    }
                    let neighbor_tile: Option<Tile> =
                        MAP_GRID.may_load(deps.storage, (game_id, neighbor.0, neighbor.1))?;
                    if let Some(neighbor_tile) = neighbor_tile {
                        let neighbor_actual = rotate_connections(
                            neighbor_tile.connections,
                            neighbor_tile.orientation,
                        );
                        let opposite_edge = (edge + 3) % 6;
                        if neighbor_actual & (1u8 << opposite_edge) != 0 {
                            connects = true;
                            break;
                        }
                    }
                }
                if !connects {
                    return Err(HexMapError::NoLegalConnection {
                        protocol_id,
                        q,
                        r,
                        hex_label: describe_hex(q, r),
                        tile_id,
                    });
                }
            }
            // else: protocol_id's very first tile ever -- becomes its Token
            // Station (Node), unconditionally accepted at whichever
            // orientation the caller submitted (no existing network to
            // validate connectivity against).
            false
        }
    };

    // Terrain Fee Timing (module doc comment #12) + Audit G-10: a hex's printed
    // terrain fee is paid exactly once, when that hex is first built on; every
    // later colour upgrade is free.
    //
    // The fee reads from the HEX (`terrain_build_fee`), not the tile laid there.
    // That closes both halves of the old exploit: an ordinary plain tile onto a
    // real river or mountain hex used to be free, and the invented "mountain
    // pass" artwork onto flat grassland used to charge $80 for nothing.
    let effective_terrain_cost = if is_upgrade {
        Uint128::zero()
    } else {
        terrain_build_fee(q, r)
    };

    let new_treasury = company
        .treasury
        .checked_sub(effective_terrain_cost)
        .map_err(|_| HexMapError::InsufficientTreasury {
            company_id: protocol_id,
            required: effective_terrain_cost,
            available: company.treasury,
        })?;

    // All checks passed -- charge the treasury, credit the bank, and
    // persist the (new or upgraded) tile and network membership.
    company.treasury = new_treasury;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    if !effective_terrain_cost.is_zero() {
        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(effective_terrain_cost)
            .map_err(|_| HexMapError::Overflow {})?;
    }
    // Inactivity Timeout Safety Valve (see `state.rs`'s
    // `GameSession::last_action_timestamp` doc comment): a successful
    // LayTile call -- upgrade or fresh placement, terrain fee or not --
    // resets the room's 48-hour inactivity clock, so this save must happen
    // unconditionally rather than only inside the nonzero-terrain-cost
    // branch above.
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    // Tile Inventory Supply Engine (Audit G-5), Effects half.
    //
    // Order matters: RECYCLE FIRST, then consume. On an upgrade the tile lifted
    // off the board returns to the tray before the new one is taken out -- so a
    // company can spend the tray's last copy in the same action that returns a
    // different copy to it, and neither operation observes a transiently negative
    // count. The two tile_ids always differ, since an upgrade is strictly one
    // colour tier up.
    if let Some(replaced_tile) = &existing_tile {
        return_tile_to_tray(deps.storage, game_id, replaced_tile.tile_id)?;
    }
    consume_tile_from_tray(deps.storage, game_id, tile_id)?;
    let remaining_after = remaining_tile_count(deps.storage, game_id, tile_id)?;

    let tile = Tile {
        q,
        r,
        tile_id,
        orientation,
        connections: base_connections,
        // Audit G-9: the tile's real internal wiring, stored alongside the flat mask
        // so `pathfinding.rs` can follow specific edge-to-edge segments instead of
        // jumping between unconnected track on the same hex. Base pre-rotation pairs;
        // `orientation` is applied at read time by `rotate_paths`, mirroring how
        // `connections` is handled.
        paths: base_paths.to_vec(),
    };
    MAP_GRID.save(deps.storage, (game_id, q, r), &tile)?;

    // Audit G-14: EXACTLY ONE tile lay per turn. Advancing the cursor here is
    // what enforces it -- there was no per-turn tile limit at all before this
    // pass, and a corporation could lay unlimited tiles in a single turn.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Track)?;

    if !is_upgrade {
        network_hexes.push((q, r));
        PROTOCOL_NETWORK_HEXES.save(deps.storage, (game_id, protocol_id), &network_hexes)?;
    }

    let mut response = Response::new()
        .add_attribute("action", "lay_tile")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("q", q.to_string())
        .add_attribute("r", r.to_string())
        .add_attribute("hex_label", describe_hex(q, r))
        .add_attribute("tile_id", tile_id.to_string())
        .add_attribute("tile_color", format!("{new_color:?}"))
        .add_attribute("orientation", orientation.to_string())
        .add_attribute("is_upgrade", is_upgrade.to_string())
        .add_attribute("terrain_cost", effective_terrain_cost)
        .add_attribute("company_treasury_remaining", company.treasury)
        .add_attribute(
            "tiles_remaining",
            if remaining_after == UNLIMITED_TILE_SUPPLY {
                "unlimited".to_string()
            } else {
                remaining_after.to_string()
            },
        );

    if let Some(replaced_tile) = &existing_tile {
        response = response
            .add_attribute("recycled_tile_id", replaced_tile.tile_id.to_string())
            .add_attribute(
                "recycled_tile_remaining",
                match remaining_tile_count(deps.storage, game_id, replaced_tile.tile_id)? {
                    UNLIMITED_TILE_SUPPLY => "unlimited".to_string(),
                    n => n.to_string(),
                },
            );
    }

    Ok(response)
}

/// This hex's effective connection bitmask for
/// `station_token_reachable_hexes`'s BFS: a real laid tile's own rotated
/// connections if one exists, else a permissive full-six-edge virtual tile
/// if this is a GRAY preprinted hex (see that function's own doc comment
/// for why), else `None` -- no connectivity at all, an ordinary hex nobody
/// has laid a tile on yet.
fn effective_connections_at(
    storage: &dyn Storage,
    game_id: u64,
    q: i32,
    r: i32,
) -> Result<Option<u8>, StdError> {
    if let Some(tile) = MAP_GRID.may_load(storage, (game_id, q, r))? {
        return Ok(Some(rotate_connections(tile.connections, tile.orientation)));
    }
    if gray_preprinted_name_at(q, r).is_some() {
        return Ok(Some(0b11_1111));
    }
    Ok(None)
}

/// Station Tokens (module doc comment #23): like `station_reachable_hexes`, but
/// ALSO treats any GRAY preprinted hex as fully connected on all six edges --
/// the same permissive virtual-tile precedent `pathfinding.rs` established.
/// Without it a permanently-un-layable GRAY city could never be reachable at
/// all, since `MAP_GRID` never holds a `Tile` there.
///
/// A SEPARATE function rather than a shared one, and that boundary is the
/// point: reachability for TOKENS may see further, through permanent gray
/// track, than reachability for LAYING NEW TILES does -- which stays exactly as
/// strict as before this feature.
fn station_token_reachable_hexes(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<(Option<(i32, i32)>, HashSet<(i32, i32)>), HexMapError> {
    let network_hexes: Vec<(i32, i32)> = PROTOCOL_NETWORK_HEXES
        .may_load(storage, (game_id, protocol_id))?
        .unwrap_or_default();
    let station = match network_hexes.first() {
        Some(home) => *home,
        None => return Ok((None, HashSet::new())),
    };

    let mut visited: HashSet<(i32, i32)> = HashSet::from([station]);
    let mut queue: VecDeque<(i32, i32)> = VecDeque::from([station]);

    while let Some(current) = queue.pop_front() {
        let Some(current_actual) = effective_connections_at(storage, game_id, current.0, current.1)?
        else {
            continue;
        };

        for edge in 0..6u8 {
            if current_actual & (1u8 << edge) == 0 {
                continue;
            }
            let (dq, dr) = HEX_NEIGHBOR_OFFSETS[edge as usize];
            let neighbor = (current.0 + dq, current.1 + dr);
            if visited.contains(&neighbor) {
                continue;
            }

            let Some(neighbor_actual) =
                effective_connections_at(storage, game_id, neighbor.0, neighbor.1)?
            else {
                continue;
            };
            let opposite_edge = (edge + 3) % 6;
            if neighbor_actual & (1u8 << opposite_edge) == 0 {
                continue;
            }

            visited.insert(neighbor);
            queue.push_back(neighbor);
        }
    }

    Ok((Some(station), visited))
}

/// Places `protocol_id`'s next Station Token at `(q, r)` at the cost
/// `station_token_cost` prices for that ordinal. Covers every token AFTER the
/// free home one, which `grant_home_station_token` awards at float.
pub fn execute_place_station_token(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    protocol_id: u32,
    q: i32,
    r: i32,
    // Audit G-12: WHICH city on `(q, r)` this token takes. `None` means "the
    // caller did not say", which resolves to the lowest-indexed city with a
    // free slot -- this keeps every pre-G-12 client working unchanged, and on
    // a single-city hex it is the only possible answer anyway.
    // (`//`, not `///`: Rust rejects doc comments on function parameters.)
    city_index: Option<u8>,
) -> Result<Response, HexMapError> {
    let mut session: GameSession = SESSIONS
        .may_load(deps.storage, game_id)?
        .ok_or(HexMapError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(HexMapError::GameNotActive { game_id });
    }

    let president = PROTOCOL_PRESIDENT
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::NoPresidentAssigned { protocol_id })?;
    if info.sender != president {
        return Err(HexMapError::NotPresident { protocol_id });
    }

    // Operating Round Corporation Turn Queue -- identical gate to
    // `execute_lay_tile`'s own (module doc comment #13).
    if let Some(&expected_protocol_id) = session
        .active_operating_order
        .get(session.active_corporation_index as usize)
    {
        if protocol_id != expected_protocol_id {
            return Err(HexMapError::NotYourOperatingTurn {
                game_id,
                protocol_id,
                expected_protocol_id,
            });
        }
    }

    let mut company: PublicCompany = PUBLIC_COMPANIES
        .may_load(deps.storage, (game_id, protocol_id))?
        .ok_or(HexMapError::PublicCompanyNotFound {
            game_id,
            company_id: protocol_id,
        })?;
    if !company.is_floated {
        return Err(HexMapError::CompanyNotFloated {
            company_id: protocol_id,
        });
    }

    // Target hex must already be a real city (module doc comment #23) -- a Station
    // Token marks an existing city stop, it does not lay track. Two ways to
    // qualify: a landmark/city-designated/OO hex with a laid city tile, OR one of
    // the six real GRAY preprinted cities, which can NEVER receive a laid tile
    // (Gray Hex Immutability) and would otherwise be permanently untokenable
    // despite being real, always-active cities.
    let existing_tile: Option<Tile> = MAP_GRID.may_load(deps.storage, (game_id, q, r))?;
    // Module doc comment #26: `BostonHub`/`NewYorkHub` are two more laid-city
    // terrains that make a hex tokenable. The "B"/"NY" restriction changes only
    // WHICH artwork may be laid there, not whether the result counts as a city.
    let is_laid_hub_tile = existing_tile
        .as_ref()
        .and_then(|tile| tile_terrain_for(tile.tile_id))
        .is_some_and(|terrain| {
            matches!(
                terrain,
                TerrainType::MajorCityHub
                    | TerrainType::DoubleCityHub
                    | TerrainType::BostonHub
                    | TerrainType::NewYorkHub
            )
        });
    let is_gray_city =
        gray_preprinted_name_at(q, r).is_some() && city_designation_name_at(q, r).is_some();
    if !is_laid_hub_tile && !is_gray_city {
        return Err(HexMapError::StationTokenHexNotACity {
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }

    // Reachability: `station_token_reachable_hexes` mirrors `execute_lay_tile`'s
    // own BFS but also treats a GRAY preprinted hex as fully connected. Read-only;
    // never mutates `PROTOCOL_NETWORK_HEXES` (module doc comment #23).
    let (station, reachable) = station_token_reachable_hexes(deps.storage, game_id, protocol_id)?;
    let is_reachable = station == Some((q, r)) || reachable.contains(&(q, r));
    if !is_reachable {
        return Err(HexMapError::StationTokenHexNotReachable {
            protocol_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }

    let mut token_hexes: Vec<(i32, i32)> = PROTOCOL_STATION_HEXES
        .may_load(deps.storage, (game_id, protocol_id))?
        .unwrap_or_default();
    if token_hexes.contains(&(q, r)) {
        return Err(HexMapError::StationTokenAlreadyOnHex {
            protocol_id,
            q,
            r,
            hex_label: describe_hex(q, r),
        });
    }


    // ==== Audit G-14: Operating Round sub-phase gate. ====
    // Strict equality against the persisted cursor -- see `or_phase`'s module
    // doc for the six-phase order and which phases may be skipped.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        protocol_id,
        OperatingSubPhase::Tokens,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => HexMapError::WrongOperatingSubPhase {
                protocol_id,
                actual: or_phase::phase_name(actual).to_string(),
                actual_index: or_phase::phase_index(actual),
                required: or_phase::phase_name(required).to_string(),
                required_index: or_phase::phase_index(required),
            },
            or_phase::PhaseMismatch::Storage(message) => HexMapError::Std(StdError::generic_err(message)),
        });
    }

    // Audit G-12: PER-CITY CAPACITY.
    //
    // There was no capacity check here at all before this pass -- only "not twice
    // on the same hex" and the company's own token limit. Nothing stopped every
    // corporation in the game from tokening the same 1-slot city, which is the
    // rule that makes contested cities contested in the first place.
    //
    // Checked per CITY, never per hex: a hex is not a city. #62 carries two
    // separate 2-slot cities and #54/#59/#64-#68 two separate 1-slot cities, so a
    // hex-level "is there room" question has no correct answer on any of them.
    let slot_counts = city_slot_counts_at(deps.storage, game_id, q, r)?;
    let occupants = hex_token_occupants(deps.storage, game_id, q, r)?;
    let chosen_city = match city_index {
        Some(requested) => {
            if usize::from(requested) >= slot_counts.len() {
                return Err(HexMapError::StationTokenCityIndexOutOfRange {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    requested,
                    city_count: u8::try_from(slot_counts.len()).unwrap_or(u8::MAX),
                });
            }
            let capacity = slot_counts[usize::from(requested)];
            if city_occupancy(&occupants, requested) >= capacity {
                return Err(HexMapError::StationTokenCityFull {
                    q,
                    r,
                    hex_label: describe_hex(q, r),
                    city_index: requested,
                    slots: capacity,
                });
            }
            requested
        }
        // No city named: take the lowest-indexed one with room. If EVERY city
        // is full the hex is genuinely closed, and that is a rejection rather
        // than a silent overflow into a full city.
        None => first_open_city(slot_counts, &occupants).ok_or_else(|| {
            HexMapError::StationTokenCityFull {
                q,
                r,
                hex_label: describe_hex(q, r),
                city_index: 0,
                slots: slot_counts.first().copied().unwrap_or(0),
            }
        })?,
    };

    let limit = station_token_limit(protocol_id);
    if token_hexes.len() >= usize::from(limit) {
        return Err(HexMapError::StationTokenLimitReached { protocol_id, limit });
    }

    // One placement per Operating Round sub-round.
    let current_subround = (session.macro_round_number, session.sub_round_index);
    if PROTOCOL_LAST_TOKEN_SUBROUND.may_load(deps.storage, (game_id, protocol_id))?
        == Some(current_subround)
    {
        return Err(HexMapError::StationTokenAlreadyPlacedThisSubRound {
            protocol_id,
            macro_round_number: current_subround.0,
            sub_round_index: current_subround.1,
        });
    }

    let token_ordinal = u8::try_from(token_hexes.len() + 1).map_err(|_| HexMapError::Overflow {})?;
    let cost = station_token_cost(token_ordinal);

    let new_treasury =
        company
            .treasury
            .checked_sub(cost)
            .map_err(|_| HexMapError::InsufficientTreasuryForStationToken {
                company_id: protocol_id,
                required: cost,
                available: company.treasury,
            })?;

    company.treasury = new_treasury;
    PUBLIC_COMPANIES.save(deps.storage, (game_id, protocol_id), &company)?;

    if !cost.is_zero() {
        session.virtual_bank_vgp = session
            .virtual_bank_vgp
            .checked_add(cost)
            .map_err(|_| HexMapError::Overflow {})?;
    }
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    PROTOCOL_LAST_TOKEN_SUBROUND.save(deps.storage, (game_id, protocol_id), &current_subround)?;

    token_hexes.push((q, r));
    let tokens_placed = token_hexes.len();
    PROTOCOL_STATION_HEXES.save(deps.storage, (game_id, protocol_id), &token_hexes)?;

    // Audit G-12: the per-city registry, written in the same commit as the hex
    // list above so the two can never disagree about whether a token exists.
    // Re-loaded rather than reusing `occupants`, because that vector includes the
    // city-0 reconstruction of any legacy token, which must NOT be persisted --
    // reconstruction is a read-time fallback, and writing it back would freeze a
    // guess into storage as though it were a record.
    let mut hex_tokens: Vec<(u32, u8)> = HEX_STATION_TOKENS
        .may_load(deps.storage, (game_id, q, r))?
        .unwrap_or_default();
    hex_tokens.push((protocol_id, chosen_city));
    HEX_STATION_TOKENS.save(deps.storage, (game_id, q, r), &hex_tokens)?;

    // Audit G-14: one token placement per turn -- advance past Tokens.
    or_phase::advance(deps.storage, game_id, protocol_id, OperatingSubPhase::Tokens)?;

    Ok(Response::new()
        .add_attribute("action", "place_station_token")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("protocol_id", protocol_id.to_string())
        .add_attribute("q", q.to_string())
        .add_attribute("r", r.to_string())
        .add_attribute("hex_label", describe_hex(q, r))
        .add_attribute("city_index", chosen_city.to_string())
        .add_attribute("token_ordinal", token_ordinal.to_string())
        .add_attribute("cost", cost)
        .add_attribute("tokens_placed", tokens_placed.to_string())
        .add_attribute("tokens_remaining", (limit - u8::try_from(tokens_placed).unwrap_or(limit)).to_string())
        .add_attribute("company_treasury_remaining", company.treasury))
}
