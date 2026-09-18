/** @jest-environment node */
//
// Slice 9.2 — the board is authoritative. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 1624 (harness): FOUR RULES THAT LIVED OUTSIDE THE AUTHORITY
// ==================================================================
//
// Stage 9.1 audited the tile/topology path and found four defects that share one seam -- the predicate the
// Node server and every replay judge a `LayTile` with. This suite is their pin.
//
//   F-1 / S9-10  an immutable hex (red off-board, preprinted gray, Coal River) refused nothing
//                authoritatively. 79 illegal lays on the standard board, 106 on the expansion, 87 on the
//                Level Playing Field -- 272 in all, measured here rather than quoted.
//   F-2 / S9-10  printed BOARD topology was invisible to the preservation rule, so a first lay over a
//                landmark was judged against nothing. Latent on the standard board (`staysOnBoard` masks
//                it); LIVE on the expansion, where Baltimore has all six neighbours.
//   F-5 / S9-17  revised 6.2.2 ❹ (stations keep their connections) lived only in `App.tsx`'s
//                `legalRotations` memo.
//   F-6 / S9-18  the Level Playing Field was missing T-02's seventh board tile, the printed straight at M-11.
//
// WHAT IS DELIBERATELY NOT PINNED HERE. S9-19 (#59's two pre-printed exits may never be connected) is Slice
// 9.3; the one assertion below about it CHARACTERIZES today's behaviour so that a 9.3 change is visible as a
// change, and must not be read as an endorsement.

import {
  filterSandboxPlacements,
  priorTopologyAt,
  type HexTopology,
} from "../components/sandboxTileLegality";
import {
  GRAY_HEXES,
  LANDMARK_HEXES,
  LANDMARK_TRACKS,
  OFFBOARD_TRACKS,
  STATIC_BOARD_HEXES,
  type BoardDefinition,
} from "../components/hexBoardData";
import {
  evaluateHexForTileLaying,
  immutableHexRefusal,
  liveEdges,
  liveEdgesForHex,
  localCatalogPlacements,
  rotateConnections,
} from "../components/hexGeometry";
import { TILE_CATALOG_BY_ID, type TileColorTier } from "../components/hexTileCatalog";
import { traversalSegments } from "../gameEngine/trackSegments";
import { initialGridFor } from "../gameEngine/initialGrid";
import { boardFor, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { tileStock } from "./tileSupply";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { effectiveLandingCity, stationAnchorRefusal } from "../gameEngine/stationAnchorAuthority";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";

const ERAS: readonly TileColorTier[] = ["Yellow", "Green", "Brown", "Gray"];

const STANDARD = resolveVariants({});
const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const LPF = resolveVariants({ levelPlayingField: true });

const RULESETS = [
  ["standard", STANDARD],
  ["1830+", PLUS],
  ["LPF", LPF],
] as const;

/** Every tile at every facing -- the unfiltered input the authority is asked to narrow. */
const ALL = localCatalogPlacements();

function bareGridFor(board: BoardDefinition): MapGridResponse {
  return initialGridFor(board);
}

function hexAt(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`${label} is not on the board in effect`);
  return { q: hex.q, r: hex.r };
}

/** Is this hex one the board forbids every tile on? Stated from the DATA, not from a coordinate list, so a
 *  board edit that adds a gray hex is covered here the day it lands. */
function isImmutable(hex: { label: string; type: string; printedColor?: string }): boolean {
  return (
    hex.type === "RedOffboard" ||
    hex.printedColor === "Gray" ||
    hex.printedColor === "Coal" ||
    GRAY_HEXES[hex.label] !== undefined
  );
}

function acceptedAt(grid: MapGridResponse, q: number, r: number, era: TileColorTier): string[] {
  return filterSandboxPlacements(ALL, { mapGrid: grid, q, r, era })
    .map((placement) => `${placement.tile_id}@${placement.orientation}`)
    .sort();
}

function acceptedAtAnyEra(grid: MapGridResponse, q: number, r: number): string[] {
  const union = new Set<string>();
  for (const era of ERAS) for (const key of acceptedAt(grid, q, r, era)) union.add(key);
  return Array.from(union).sort();
}

/* ====================================================================== */
/*  F-1 / S9-10 — the hex itself refuses                                  */
/* ====================================================================== */

describe("F-1: an immutable hex refuses every tile, authoritatively", () => {
  it.each(RULESETS)("%s: no tile, at any facing, at any era, on any immutable hex", (_name, variants) => {
    const grid = bareGridFor(boardFor(variants));
    withRules(variants, () => {
      const immutable = STATIC_BOARD_HEXES.filter(isImmutable);
      // The sweep has to have something to sweep, or an empty list would pass vacuously.
      expect(immutable.length).toBeGreaterThan(10);
      for (const hex of immutable) {
        expect({ hex: hex.label, accepted: acceptedAtAnyEra(grid, hex.q, hex.r) }).toEqual({
          hex: hex.label,
          accepted: [],
        });
      }
    });
  });

  it("covers every category the manifest names: gray city, gray town, gray connector, red off-board, Coal", () => {
    withRules(STANDARD, () => {
      const grid = bareGridFor(boardFor(STANDARD));
      // Cleveland F6 is the case `src/tests.rs:5205` asserts on the contract, tile and all.
      expect(acceptedAt(grid, hexAt("F6").q, hexAt("F6").r, "Yellow")).toEqual([]);
      expect(immutableHexRefusal(hexAt("F6").q, hexAt("F6").r)?.reason).toBe("gray-immutable");
      expect(
        filterSandboxPlacements([{ tile_id: 57, orientation: 0 }], {
          mapGrid: grid,
          q: hexAt("F6").q,
          r: hexAt("F6").r,
          era: "Yellow",
        }),
      ).toEqual([]);
      // C15 Kingston, a gray TOWN; E9, a gray connector with no centre at all.
      expect(immutableHexRefusal(hexAt("C15").q, hexAt("C15").r)?.reason).toBe("gray-immutable");
      expect(immutableHexRefusal(hexAt("E9").q, hexAt("E9").r)?.reason).toBe("gray-immutable");
      // A9, a red off-board area -- refused for its own reason, checked FIRST (`hexmap.rs:2317`).
      expect(immutableHexRefusal(hexAt("A9").q, hexAt("A9").r)?.reason).toBe("offboard");
      // And a coordinate that is not a hex at all.
      expect(immutableHexRefusal(999, 999)?.reason).toBe("not-a-hex");
    });
    withRules(LPF, () => {
      // Coal River is printed in its own colour and is fixed for a gray hex's reason (#1320).
      const l8 = hexAt("L8");
      expect(immutableHexRefusal(l8.q, l8.r)?.reason).toBe("gray-immutable");
      expect(acceptedAtAnyEra(bareGridFor(boardFor(LPF)), l8.q, l8.r)).toEqual([]);
    });
  });

  it("leaves ordinary board hexes alone -- the control every refusal test needs", () => {
    withRules(STANDARD, () => {
      const grid = bareGridFor(boardFor(STANDARD));
      /* Plain, mountain, river, a blank city designation and a printed yellow OO: a representative row of
         everything that is NOT immutable. Each must still offer tiles, or F-1 has been over-applied. */
      for (const label of ["G15", "F16", "E19", "B20", "I13", "D18", "E11", "H18", "K7"]) {
        const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
        if (!hex) continue;
        expect({ label, any: acceptedAtAnyEra(grid, hex.q, hex.r).length > 0 }).toEqual({ label, any: true });
      }
    });
  });

  it("is ONE predicate: the click gate and the authority cannot drift", () => {
    for (const [, variants] of RULESETS) {
      withRules(variants, () => {
        const grid = bareGridFor(boardFor(variants));
        for (const hex of STATIC_BOARD_HEXES) {
          const refused = immutableHexRefusal(hex.q, hex.r) !== null;
          if (!refused) continue;
          // What the player is told...
          const click = evaluateHexForTileLaying(hex.q, hex.r, grid);
          expect(click.eligible).toBe(false);
          // ...and what a replay applies.
          expect(acceptedAtAnyEra(grid, hex.q, hex.r)).toEqual([]);
        }
      });
    }
  });

  it("refuses exactly the hexes the board data calls immutable, and no others", () => {
    for (const [, variants] of RULESETS) {
      withRules(variants, () => {
        for (const hex of STATIC_BOARD_HEXES) {
          expect({ label: hex.label, refused: immutableHexRefusal(hex.q, hex.r) !== null }).toEqual({
            label: hex.label,
            refused: isImmutable(hex),
          });
        }
      });
    }
  });
});

/* ====================================================================== */
/*  F-2 / S9-10 — printed board topology is source topology               */
/* ====================================================================== */

describe("F-2: the board's own printed track is preserved on a first lay", () => {
  it("Baltimore keeps its printed rail -- and on the EXPANSION that is not `staysOnBoard` doing the work", () => {
    /* THE MASKING BROKE WHEN THE MAP GREW. On the standard board I15 lacks a neighbour across the
       wrong-parity edges, so the rim test alone happened to refuse the facings that cut Baltimore's printed
       {0,4}. The expansion gives it all six, and six track-deleting lays survived the rim test and were
       accepted (three on the Level Playing Field, where #592 is out of the tray). */
    for (const [name, variants, expected] of [
      ["standard", STANDARD, ["53@0", "53@2", "53@4"]],
      ["1830+", PLUS, ["53@0", "53@2", "53@4", "592@0", "592@2", "592@4"]],
      ["LPF", LPF, ["53@0", "53@2", "53@4"]],
    ] as const) {
      withRules(variants, () => {
        const grid = bareGridFor(boardFor(variants));
        const i15 = hexAt("I15");
        expect({ name, offered: acceptedAtAnyEra(grid, i15.q, i15.r) }).toEqual({ name, offered: [...expected] });
        // Every surviving facing really does carry both printed edges.
        for (const key of acceptedAtAnyEra(grid, i15.q, i15.r)) {
          const [tileId, orientation] = key.split("@").map(Number);
          const entry = TILE_CATALOG_BY_ID.get(tileId)!;
          const edges = liveEdges(rotateConnections(entry.connections, orientation));
          expect({ key, keeps: [0, 4].every((edge) => edges.includes(edge)) }).toEqual({ key, keeps: true });
        }
      });
    }
  });

  it("Boston is refused for the right reason too", () => {
    withRules(PLUS, () => {
      const grid = bareGridFor(boardFor(PLUS));
      const e23 = hexAt("E23");
      const offered = acceptedAtAnyEra(grid, e23.q, e23.r);
      expect(offered).toEqual(["53@1", "53@3", "53@5", "592@1", "592@3", "592@5"]);
      const prior = priorTopologyAt(grid, e23.q, e23.r)!;
      expect(prior.source).toBe("landmark");
      expect(liveEdges(prior.mask)).toEqual([1, 5]);
    });
  });

  it("New York's two DISCONNECTED spurs are termini, so the upgrade that joins them stays legal", () => {
    /* The relaxation design note #676 found for #59's `[[0,0],[2,2]]`, arriving from the board side: New
       York prints two cities with no track between them, and connecting them is what the green tile is FOR.
       Requiring a printed terminus to remain a terminus would freeze G19 forever. */
    withRules(STANDARD, () => {
      const grid = bareGridFor(boardFor(STANDARD));
      const g19 = LANDMARK_HEXES.find((entry) => entry.name === "New York")!;
      const prior = priorTopologyAt(grid, g19.q, g19.r)!;
      expect(prior.source).toBe("landmark");
      expect(prior.segments).toEqual([
        [1, 1],
        [4, 4],
      ]);
      expect(acceptedAtAnyEra(grid, g19.q, g19.r)).toEqual(["54@1"]);
    });
  });

  it("a laid tile still governs its own hex -- printed is the FALLBACK, never a union", () => {
    withRules(PLUS, () => {
      const i15 = hexAt("I15");
      /* #53 at facing 0 keeps Baltimore's {0,4} and adds edge 2. Once it is down, the hex's topology is the
         TILE's: the brown successors are judged against {0,2,4}, and the printed landmark is no longer a
         separate claim on the hex. */
      const laid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: i15.q, r: i15.r, tile_id: 53, orientation: 0, landmark: "Baltimore" }],
      };
      const prior = priorTopologyAt(laid, i15.q, i15.r)!;
      expect(prior.source).toBe("laid");
      expect(liveEdges(prior.mask)).toEqual([0, 2, 4]);
      expect(prior.segments).toEqual([
        [0, 2],
        [0, 4],
        [2, 4],
      ]);
    });
  });

  it("resolves in `liveEdgesForHex`'s order, so the route graph and the authority cannot disagree", () => {
    /* THE CLAIM THAT MATTERS, checked over every hex of every board rather than argued: whatever the route
       graph believes is live on a hex, the lay predicate preserves exactly that. */
    for (const [name, variants] of RULESETS) {
      withRules(variants, () => {
        const grid = bareGridFor(boardFor(variants));
        for (const hex of STATIC_BOARD_HEXES) {
          const prior = priorTopologyAt(grid, hex.q, hex.r);
          const routeEdges = liveEdgesForHex(grid, hex.q, hex.r).sort((a, b) => a - b);
          expect({ name, hex: hex.label, edges: prior === null ? [] : liveEdges(prior.mask) }).toEqual({
            name,
            hex: hex.label,
            edges: routeEdges,
          });
        }
        // And the landmarks, which are not in `STATIC_BOARD_HEXES`' own printed tables.
        for (const landmark of LANDMARK_HEXES) {
          const prior = priorTopologyAt(grid, landmark.q, landmark.r);
          expect(prior?.source).toBe("landmark");
          expect(liveEdges(prior!.mask)).toEqual(
            liveEdgesForHex(grid, landmark.q, landmark.r).sort((a, b) => a - b),
          );
        }
      });
    }
  });

  it("names its source, and the arms are the ones the board actually has", () => {
    withRules(LPF, () => {
      const grid = bareGridFor(boardFor(LPF));
      const sources = new Map<string, HexTopology["source"]>();
      for (const hex of STATIC_BOARD_HEXES) {
        const prior = priorTopologyAt(grid, hex.q, hex.r);
        if (prior) sources.set(hex.label, prior.source);
      }
      expect(sources.get("E9")).toBe("gray");
      expect(sources.get("M13")).toBe("gray"); // an LPF warehouse carries a gray-track entry (#1320)
      expect(sources.get("M11")).toBe("laid"); // #1622: the printed straight IS a laid tile
      expect(Object.keys(OFFBOARD_TRACKS).length).toBeGreaterThan(0);
    });
    withRules(STANDARD, () => {
      const grid = bareGridFor(boardFor(STANDARD));
      const a9 = hexAt("A9");
      expect(priorTopologyAt(grid, a9.q, a9.r)?.source).toBe("offboard");
      // A red area's stubs END there -- `trackSegments.ts` #484 answers `null` for one before it looks at a tile.
      expect(priorTopologyAt(grid, a9.q, a9.r)?.segments).toEqual([[5, 5]]);
    });
  });

  it("#59 still upgrades, and now only to facings that keep its two systems apart (S9-19 landed in 9.3)", () => {
    /* WAS A CHARACTERIZATION, IS NOW A RESULT. At 9.2 this pinned "the filter offers something for a laid
       #59" with an explicit note that revised 6.2.2 ❹'s separation clause was NOT implemented. Slice 9.3
       implemented it (`hexTileCatalog` #1628, `sandboxTileLegality` #1628), so the interesting half is no
       longer "something is offered" but "what is offered still covers every listed successor".
       The full matrix, the seven audited illegal facings and the control proving generic merges stayed legal
       all live in `stage93TileAuthority.test.ts`; this is the Stage-9.2 suite's own cross-check that 9.3 did
       not close the OO chain on the STANDARD board, which 9.3's own suite measures on the expansion. */
    withRules(STANDARD, () => {
      const e11 = hexAt("E11");
      const laid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: e11.q, r: e11.r, tile_id: 59, orientation: 0, landmark: null }],
      };
      const offered = acceptedAtAnyEra(laid, e11.q, e11.r);
      // The five Classic browns, two facings each -- #64@2/@4, #65@0/@4, #66@0/@5, #67@0/@2, #68@2/@5.
      expect(offered).toEqual(["64@2", "64@4", "65@0", "65@4", "66@0", "66@5", "67@0", "67@2", "68@2", "68@5"]);
    });
  });
});

/* ====================================================================== */
/*  F-6 / S9-18 — the Level Playing Field's printed straight at M-11       */
/* ====================================================================== */

describe("F-6: T-02's seventh board tile, the straight at M-11", () => {
  const M11 = { q: -1, r: 12 };

  it("is printed on the Level Playing Field board from setup, joining M-9 to M-13", () => {
    withRules(LPF, () => {
      const grid = bareGridFor(boardFor(LPF));
      const tile = grid.tiles.find((entry) => entry.q === M11.q && entry.r === M11.r);
      expect(tile).toBeDefined();
      expect(tile!.tile_id).toBe(9);
      expect(tile!.orientation).toBe(0);
      expect(tile!.printed).toBe(true);
      // The coordinate arithmetic, stated rather than assumed: edge 0 is M-13, edge 3 is M-9.
      expect(hexAt("M11")).toEqual(M11);
      expect(hexAt("M13")).toEqual({ q: M11.q + 1, r: M11.r });
      expect(hexAt("M9")).toEqual({ q: M11.q - 1, r: M11.r });
    });
  });

  it("the route graph sees it, and it runs THROUGH rather than stopping", () => {
    withRules(LPF, () => {
      const grid = bareGridFor(boardFor(LPF));
      expect(liveEdgesForHex(grid, M11.q, M11.r).sort()).toEqual([0, 3]);
      expect(traversalSegments(grid, M11.q, M11.r, 0, 3)).not.toBeNull();
      // And it is not a junction it does not have: there is no rail from edge 0 to edge 1.
      expect(traversalSegments(grid, M11.q, M11.r, 0, 1)).toBeNull();
    });
  });

  it("a tile that preserves the straight is accepted; one that cuts it is refused", () => {
    withRules(LPF, () => {
      const grid = bareGridFor(boardFor(LPF));
      const offered = acceptedAtAnyEra(grid, M11.q, M11.r);
      expect(offered.length).toBeGreaterThan(0);
      for (const key of offered) {
        const [tileId, orientation] = key.split("@").map(Number);
        const entry = TILE_CATALOG_BY_ID.get(tileId)!;
        const edges = liveEdges(rotateConnections(entry.connections, orientation));
        expect({ key, keeps: edges.includes(0) && edges.includes(3) }).toEqual({ key, keeps: true });
        expect({ key, colour: entry.color }).toEqual({ key, colour: "Green" });
      }
      // The yellow tiles a blank hex used to take are gone: the hex already holds yellow track.
      expect(offered).not.toContain("8@0");
      expect(offered).not.toContain("9@0");
      expect(acceptedAt(grid, M11.q, M11.r, "Yellow")).toEqual([]);
    });
  });

  it("costs the tray nothing -- the board printed it, the players did not", () => {
    withRules(LPF, () => {
      const grid = bareGridFor(boardFor(LPF));
      const stock = tileStock(grid, 9)!;
      expect(stock.placed).toBe(0);
      expect(stock.remaining).toBe(stock.printed);
    });
  });

  it("belongs to the Level Playing Field alone", () => {
    for (const [name, variants] of [
      ["standard", STANDARD],
      ["1830+", PLUS],
    ] as const) {
      withRules(variants, () => {
        const grid = bareGridFor(boardFor(variants));
        expect({ name, atM11: grid.tiles.some((t) => t.q === M11.q && t.r === M11.r) }).toEqual({
          name,
          atM11: false,
        });
      });
    }
    // On the expansion M-11 is still a blank plain hex that takes yellow track.
    withRules(PLUS, () => {
      const grid = bareGridFor(boardFor(PLUS));
      expect(acceptedAt(grid, M11.q, M11.r, "Yellow")).toContain("9@0");
    });
  });
});

/* ====================================================================== */
/*  F-5 / S9-17 — station anchoring in the authority                      */
/* ====================================================================== */

const NY = { q: 6, r: 6 };
const NYC = 2;
const NNH = 7;

function stateWith(companies: StationTokenCompany[]): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [NYC],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: "Track",
    public_companies: companies.map((company) => ({
      ...company,
      president: "p1",
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "1000",
      owned_trains: ["4"],
      player_holdings: [{ player: "p1", percentage: 100 }],
    })),
  } as unknown as GameStateResponse;
}

function tokened(id: number, ticker: string, city: number): StationTokenCompany {
  return {
    company_id: id,
    ticker,
    is_floated: true,
    station_token_hexes: [[NY.q, NY.r]],
    station_tokens: [[NY.q, NY.r, city]],
  } as unknown as StationTokenCompany;
}

describe("F-5: revised 6.2.2 ❹ is enforced by the authority, not by a memo", () => {
  /* #62 at facing 1 puts city 0 on New York's north-east pair and city 1 on its south-west pair; #883 at
     facing 3 covers the same four edges with ONE four-slot city (#1315, `nyMerge.test.ts`). */
  const withSixtyTwo: MapGridResponse = {
    game_id: 1,
    tiles: [{ q: NY.q, r: NY.r, tile_id: 62, orientation: 1, landmark: "New York" }],
  };

  it("accepts the landing that keeps a station's connections", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)]);
      expect(
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 883, orientation: 3, token_cities: [[NYC, 0], [NNH, 0]] },
          withSixtyTwo,
        ),
      ).toBeNull();
    });
  });

  it("refuses a station moved onto a city that does not carry its connections", () => {
    withRules(PLUS, () => {
      /* THE CASE A CRAFTED MESSAGE BUILDS, and the one the shell could never produce: an upgrade whose plan
         anchors a token at one city and whose payload names the other. New York's green #54 to brown #62,
         both two-city tiles at the same facing -- city 0 owns edges {1,2} and city 1 owns {3,4}, so the two
         landings are genuinely different networks rather than one city under two names. */
      const withFiftyFour: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: NY.q, r: NY.r, tile_id: 54, orientation: 1, landmark: "New York" }],
      };
      const state = stateWith([tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)]);
      // The landing connectivity derives is legal...
      expect(
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 62, orientation: 1, token_cities: [[NYC, 0], [NNH, 1]] },
          withFiftyFour,
        ),
      ).toBeNull();
      // ...and swapping the two tokens is not, in either direction.
      expect(
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 62, orientation: 1, token_cities: [[NYC, 1], [NNH, 0]] },
          withFiftyFour,
        ),
      ).toMatch(/station must stay with the track it already reaches/);
      // And naming only ONE of them wrongly is refused just the same.
      expect(
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 62, orientation: 1, token_cities: [[NYC, 1], [NNH, 1]] },
          withFiftyFour,
        ),
      ).not.toBeNull();
      // The old single-index spelling (#824) is judged by the same rule, not waved through.
      expect(
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 62, orientation: 1, token_city: 1 },
          withFiftyFour,
        ),
      ).not.toBeNull();
    });
  });

  it("refuses a facing that strands a station", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)]);
      /* Some facing of #883 must fail to carry BOTH tokens' edge sets, or the rule has nothing to refuse.
         Found rather than assumed. */
      const facings = [0, 1, 2, 3, 4, 5].map((orientation) => ({
        orientation,
        refusal: stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 883, orientation, token_cities: [[NYC, 0], [NNH, 0]] },
          withSixtyTwo,
        ),
      }));
      expect(facings.some((entry) => entry.refusal !== null)).toBe(true);
      expect(facings.some((entry) => entry.refusal === null)).toBe(true);
    });
  });

  it("refuses a capacity shrink that cannot seat the tokens standing there", () => {
    /* #592 (2 slots) -> #61 (1 slot) is the tile set's ONLY capacity-shrinking upgrade (§7 class B-). With
       two tokens in the #592 city it is illegal, and `nyMerge.test.ts` pinned that refusal IN THE UI. */
    withRules(PLUS, () => {
      const i15 = hexAt("I15");
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: i15.q, r: i15.r, tile_id: 592, orientation: 0, landmark: "Baltimore" }],
      };
      const two = [
        { ...tokened(NYC, "NYC", 0), station_token_hexes: [[i15.q, i15.r]], station_tokens: [[i15.q, i15.r, 0]] },
        { ...tokened(NNH, "NNH", 0), station_token_hexes: [[i15.q, i15.r]], station_tokens: [[i15.q, i15.r, 0]] },
      ] as unknown as StationTokenCompany[];
      const one = [two[0]];
      const lay = { q: i15.q, r: i15.r, tile_id: 61, orientation: 0, token_cities: [] as Array<[number, number]> };
      // One token fits the single slot...
      expect(stationAnchorRefusal(stateWith(one), lay, grid)).toBeNull();
      // ...two do not.
      expect(stationAnchorRefusal(stateWith(two), lay, grid)).not.toBeNull();
    });
  });

  it("has no opinion without a board, and none on a hex with no station", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", 0)]);
      expect(
        stationAnchorRefusal(state, { q: NY.q, r: NY.r, tile_id: 883, orientation: 3 }, undefined),
      ).toBeNull();
      expect(
        stationAnchorRefusal(stateWith([]), { q: NY.q, r: NY.r, tile_id: 883, orientation: 3 }, withSixtyTwo),
      ).toBeNull();
    });
  });

  it("the REDUCER refuses, and refuses before it mutates anything", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)]);
      const illegal = [0, 1, 2, 3, 4, 5].find(
        (orientation) =>
          stationAnchorRefusal(
            state,
            { q: NY.q, r: NY.r, tile_id: 883, orientation, token_cities: [[NYC, 0], [NNH, 0]] },
            withSixtyTwo,
          ) !== null,
      );
      expect(illegal).toBeDefined();
      const msg = {
        LayTile: {
          game_id: 1,
          protocol_id: NYC,
          q: NY.q,
          r: NY.r,
          tile_id: 883,
          orientation: illegal!,
          token_cities: [[NYC, 0], [NNH, 0]] as Array<[number, number]>,
        },
      };
      /* IDENTITY, not deep equality: the terrain fee, the sub-phase cursor and the token map all hang off
         this arm, and returning the same object is how this reducer spells "nothing happened" (#712/#891). */
      const after = applySandboxAction(state, msg as never, { mapGrid: withSixtyTwo });
      expect(after).toBe(state);
      expect(after.operating_sub_phase).toBe("Track");
    });
  });

  it("a legal lay still lands, which is the control", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)]);
      const msg = {
        LayTile: {
          game_id: 1,
          protocol_id: NYC,
          q: NY.q,
          r: NY.r,
          tile_id: 883,
          orientation: 3,
          token_cities: [[NYC, 0], [NNH, 0]] as Array<[number, number]>,
        },
      };
      const after = applySandboxAction(state, msg as never, { mapGrid: withSixtyTwo });
      expect(after).not.toBe(state);
    });
  });
});

/* ====================================================================== */
/*  Private special powers keep their own exceptions and gain none         */
/* ====================================================================== */

describe("the private companies' special hexes are ordinary ground, and stay that way", () => {
  it.each([
    ["CSL", "B20"],
    ["D&H", "F16"],
    ["NYC", "E19"],
    ["ERIE", "E11"],
  ])("%s's hex (%s) is buildable, and by the ordinary rules", (_power, label) => {
    for (const [name, variants] of RULESETS) {
      withRules(variants, () => {
        const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
        if (!hex) return;
        const grid = bareGridFor(boardFor(variants));
        // Not immutable: a special power must not have been locked out by F-1.
        expect({ name, label, refused: immutableHexRefusal(hex.q, hex.r) !== null }).toEqual({
          name,
          label,
          refused: false,
        });
        // And it still offers tiles.
        expect({ name, label, any: acceptedAtAnyEra(grid, hex.q, hex.r).length > 0 }).toEqual({
          name,
          label,
          any: true,
        });
      });
    }
  });

  it("D&H's F16 takes the one yellow city tile it is promised", () => {
    withRules(STANDARD, () => {
      const f16 = hexAt("F16");
      const grid = bareGridFor(boardFor(STANDARD));
      expect(acceptedAt(grid, f16.q, f16.r, "Yellow").map((k) => k.split("@")[0])).toEqual(
        expect.arrayContaining(["57"]),
      );
    });
  });

  it("ERIE's E11 stays rotatable while its token has no track to preserve", () => {
    /* #878's general rule rather than a named exception: a token with no live edges has nothing to lose, so
       every facing satisfies ❹ vacuously. The authority must reproduce that, or ERIE's home freezes. */
    withRules(STANDARD, () => {
      const e11 = hexAt("E11");
      const bare: MapGridResponse = { game_id: 1, tiles: [] };
      const erie = {
        company_id: 6,
        ticker: "ERIE",
        is_floated: true,
        station_token_hexes: [[e11.q, e11.r]],
        station_tokens: [[e11.q, e11.r, 1]],
      } as unknown as StationTokenCompany;
      for (let orientation = 0; orientation < 6; orientation += 1) {
        expect({
          orientation,
          refusal: stationAnchorRefusal(
            stateWith([erie]),
            { q: e11.q, r: e11.r, tile_id: 59, orientation, token_cities: [[6, 0]] },
            bare,
          ),
        }).toEqual({ orientation, refusal: null });
      }
    });
  });
});

/* ====================================================================== */
/*  F-5 follow-up — OMITTED token fields must not weaken legality          */
/* ====================================================================== */

/* ==================================================================
    DESIGN NOTE 1625 (harness): THE FIELDS A CLIENT CAN SIMPLY NOT SEND
   ==================================================================

   `token_cities` and `token_city` are OPTIONAL on `ExecuteMsg::LayTile`, and `station_tokens` is optional on
   the state — all three placement arms (`sandboxSession.ts` :5535, :6215, :6278) accept `city_index === null`
   and write `station_token_hexes` WITHOUT a `station_tokens` entry, exactly as design note #560 intends
   ("absent means this chain predates G-12"). So "a station whose city nobody recorded" is not a hypothetical:
   it is a first-class state this reducer produces, and a direct client reaches it by omitting one field.

   THE REQUIREMENT IS ABOUT STATIONS, NOT ABOUT MAPPINGS. Revised 6.2.2 ❹ speaks of "all stations on the
   replaced tile" — every station standing on the hex must have a legal destination and must count against the
   destination's slots, whether or not the message troubled to name it. A client must not be able to buy
   legality by sending less. */

describe("F-5 follow-up: omitting token_cities / token_city cannot buy legality", () => {
  const I15 = { q: 3, r: 8 };
  const E11 = { q: 3, r: 4 };
  const A = 2;
  const B = 7;
  const C = 4;

  /** A station whose city index the chain DID record. */
  function indexed(id: number, ticker: string, hex: { q: number; r: number }, city: number): StationTokenCompany {
    return {
      company_id: id,
      ticker,
      is_floated: true,
      station_token_hexes: [[hex.q, hex.r]],
      station_tokens: [[hex.q, hex.r, city]],
    } as unknown as StationTokenCompany;
  }

  /** A station standing on the hex that NO `station_tokens` entry describes — #560's third state, and the
   *  one a `PlaceStationToken` with `city_index: null` produces. */
  function unindexed(id: number, ticker: string, hex: { q: number; r: number }): StationTokenCompany {
    return {
      company_id: id,
      ticker,
      is_floated: true,
      station_token_hexes: [[hex.q, hex.r]],
      station_tokens: null,
    } as unknown as StationTokenCompany;
  }

  it("1. WRONG CONNECTION, no token_cities: the stored index is judged, not waved through", () => {
    withRules(PLUS, () => {
      /* New York's green #54 at facing 1 puts city 0 on edges {1,2}. Brown #62 at facing 5 puts city 0 on
         {5,0} and city 1 on {1,2} -- so connectivity says the token belongs in city ONE. The message says
         nothing at all, and the mutation would leave it in city 0: a different network. */
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: NY.q, r: NY.r, tile_id: 54, orientation: 1, landmark: "New York" }],
      };
      const state = stateWith([indexed(A, "NYC", NY, 0)]);
      const refusal = stationAnchorRefusal(state, { q: NY.q, r: NY.r, tile_id: 62, orientation: 5 }, grid);
      expect(refusal).toMatch(/station must stay with the track it already reaches/);
      // The control: the facing where the stored index IS the anchor is accepted with the same silent message.
      expect(
        stationAnchorRefusal(state, { q: NY.q, r: NY.r, tile_id: 62, orientation: 1 }, grid),
      ).toBeNull();
    });
  });

  it("2. CAPACITY SHRINK, no token_cities: #592 -> #61 with two stations is refused", () => {
    withRules(PLUS, () => {
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: I15.q, r: I15.r, tile_id: 592, orientation: 0, landmark: "Baltimore" }],
      };
      const lay = { q: I15.q, r: I15.r, tile_id: 61, orientation: 0 };
      // Two stations, no mapping sent at all.
      expect(stationAnchorRefusal(stateWith([indexed(A, "NYC", I15, 0), indexed(B, "NNH", I15, 0)]), lay, grid)).not.toBeNull();
      // Two stations, neither indexed by the chain either -- the same answer.
      expect(stationAnchorRefusal(stateWith([unindexed(A, "NYC", I15), unindexed(B, "NNH", I15)]), lay, grid)).not.toBeNull();
      // One station fits the single slot: the control.
      expect(stationAnchorRefusal(stateWith([indexed(A, "NYC", I15, 0)]), lay, grid)).toBeNull();
    });
  });

  it("3. MIXED named + unnamed: the unnamed station still counts", () => {
    withRules(PLUS, () => {
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: I15.q, r: I15.r, tile_id: 592, orientation: 0, landmark: "Baltimore" }],
      };
      /* Naming ONE of the two tokens must not make the other invisible: #61 has one slot and two stations
         stand on the hex. */
      expect(
        stationAnchorRefusal(
          stateWith([indexed(A, "NYC", I15, 0), indexed(B, "NNH", I15, 0)]),
          { q: I15.q, r: I15.r, tile_id: 61, orientation: 0, token_cities: [[A, 0]] },
          grid,
        ),
      ).not.toBeNull();
      // And naming one while the other is unindexed is the same.
      expect(
        stationAnchorRefusal(
          stateWith([indexed(A, "NYC", I15, 0), unindexed(B, "NNH", I15)]),
          { q: I15.q, r: I15.r, tile_id: 61, orientation: 0, token_cities: [[A, 0]] },
          grid,
        ),
      ).not.toBeNull();
    });
  });

  it("3b. THE BYPASS: free, unindexed stations on a bare OO hex must still fit the tile's slots", () => {
    withRules(STANDARD, () => {
      /* THE EXPLOIT THIS FOLLOW-UP CLOSES. A token with no live edges to preserve is `free` (#878), and
         `fitStationsToUpgrade` maps a free token on a MULTI-city candidate to `null` -- "the president still
         chooses" -- so it counts against no city (#1315). On a bare printed OO hex every token is free, and
         before this follow-up `stationAnchorRefusal` also skipped any token the chain had not indexed. Three
         stations could therefore be seated on #59's two slots by a message that simply said nothing. */
      const bare: MapGridResponse = { game_id: 1, tiles: [] };
      const lay = { q: E11.q, r: E11.r, tile_id: 59, orientation: 0 };
      // Two stations, two slots: legal, and it must stay legal.
      expect(
        stationAnchorRefusal(stateWith([unindexed(A, "NYC", E11), unindexed(B, "NNH", E11)]), lay, bare),
      ).toBeNull();
      // Three stations, two slots: no arrangement is legal, whatever the message says or does not say.
      expect(
        stationAnchorRefusal(
          stateWith([unindexed(A, "NYC", E11), unindexed(B, "NNH", E11), unindexed(C, "B&O", E11)]),
          lay,
          bare,
        ),
      ).not.toBeNull();
      // Naming them does not help either.
      expect(
        stationAnchorRefusal(
          stateWith([unindexed(A, "NYC", E11), unindexed(B, "NNH", E11), unindexed(C, "B&O", E11)]),
          { ...lay, token_cities: [[A, 0], [B, 1], [C, 0]] },
          bare,
        ),
      ).not.toBeNull();
    });
  });

  it("4. an unambiguous legal omitted mapping is still accepted", () => {
    withRules(PLUS, () => {
      /* PROOF THAT THIS IS NOT A FIELD REQUIRED FOR ITS OWN SAKE. A same-topology upgrade where the stored
         index is exactly where connectivity puts the token replays untouched with no mapping sent -- which is
         what an older log looks like. */
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: NY.q, r: NY.r, tile_id: 54, orientation: 1, landmark: "New York" }],
      };
      expect(
        stationAnchorRefusal(
          stateWith([indexed(A, "NYC", NY, 0), indexed(B, "NNH", NY, 1)]),
          { q: NY.q, r: NY.r, tile_id: 62, orientation: 1 },
          grid,
        ),
      ).toBeNull();
      // And the single-station ordinary case: a one-city yellow to a one-city green, nothing named.
      const f16 = hexAt("F16");
      const yellow: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: f16.q, r: f16.r, tile_id: 57, orientation: 0, landmark: null }],
      };
      expect(
        stationAnchorRefusal(
          stateWith([indexed(A, "NYC", f16, 0)]),
          { q: f16.q, r: f16.r, tile_id: 14, orientation: 0 },
          yellow,
        ),
      ).toBeNull();
    });
  });

  it("5. a NAMED malicious mapping is still refused, and the reducer still mutates nothing", () => {
    withRules(PLUS, () => {
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q: NY.q, r: NY.r, tile_id: 54, orientation: 1, landmark: "New York" }],
      };
      const state = stateWith([indexed(A, "NYC", NY, 0), indexed(B, "NNH", NY, 1)]);
      const msg = {
        LayTile: {
          game_id: 1,
          protocol_id: A,
          q: NY.q,
          r: NY.r,
          tile_id: 62,
          orientation: 1,
          token_cities: [[A, 1], [B, 0]] as Array<[number, number]>,
        },
      };
      expect(stationAnchorRefusal(state, msg.LayTile, grid)).not.toBeNull();
      expect(applySandboxAction(state, msg as never, { mapGrid: grid })).toBe(state);
    });
  });

  it("the mutation mirror is exact: effectiveLandingCity == what the LayTile arm writes", () => {
    withRules(PLUS, () => {
      const lay = { q: NY.q, r: NY.r, tile_id: 62, orientation: 1 };
      const withMap = { ...lay, token_cities: [[A, 1]] as Array<[number, number]> };
      const withOld = { ...lay, token_city: 1 };
      const a = indexed(A, "NYC", NY, 0);
      const b = indexed(B, "NNH", NY, 1);
      // named wins...
      expect(effectiveLandingCity(a, NY.q, NY.r, withMap, 2)).toBe(1);
      // ...a company the map does not name keeps its stored index (the arm returns it unchanged)...
      expect(effectiveLandingCity(b, NY.q, NY.r, withMap, 2)).toBe(1);
      // ...the old single-index spelling applies to everybody when the map is empty...
      expect(effectiveLandingCity(a, NY.q, NY.r, withOld, 2)).toBe(1);
      // ...nothing named at all falls back to the stored index...
      expect(effectiveLandingCity(a, NY.q, NY.r, lay, 2)).toBe(0);
      // ...an out-of-range index is clamped exactly as `clampCity` clamps it...
      expect(effectiveLandingCity(a, NY.q, NY.r, { ...lay, token_cities: [[A, 9]] }, 2)).toBe(1);
      // ...and a station the chain never indexed has no mutation-side answer at all.
      expect(effectiveLandingCity(unindexed(C, "B&O", NY), NY.q, NY.r, lay, 2)).toBeUndefined();
    });
  });
});
