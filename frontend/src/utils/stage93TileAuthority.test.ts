/** @jest-environment node */
//
// Slice 9.3 — #59's separation clause, #63's physical supply, and canonical tile identities. No React, no
// canvas.
//
// ==================================================================
//  DESIGN NOTE 1631 (harness): THREE AUDITED FINDINGS, AND THE ONE THAT HAD TO NOT GENERALIZE
// ==================================================================
//
//   S9-19  revised 6.2.2 ❹'s last sentence -- "the pre-printed exits on a (59) tile can never be connected in
//          the tile upgrade" -- lived nowhere. `preservesRouting` compares segments and has no notion of which
//          city an exit lands in, so an upgrade that KEEPS both of #59's stubs and JOINS them read as a pure
//          addition. Seven (tile, facing) pairs were accepted that the printed rule forbids.
//   S9-15  the 1830+ tray held ONE #63 against T-09's `3 +1` and the errata sheet's "all four C15 tiles",
//          because the variant tray writes TOTALS with `counts.set` and the row carried the "+1" column.
//   S9-21  the three tiles whose printed old numbers the errata voids were keyed on those numbers with
//          nothing in the repo recording that they are void.
//
// THE DANGEROUS ONE IS S9-19, and not because it is hard. Stage 9.1 proved there are LEGITIMATE
// topology-changing upgrades -- New York's two severed printed cities become one connected green #54,
// Baltimore's chain changes topology, the town-merge family (#1403) exists to join two centres into one. A
// rule phrased as "source components may never merge", or "two cities must stay two cities", or "city count is
// constant", refuses every one of those. So the last describe below is not a nicety: it is the control that
// proves the special rule did not leak into generic legality, and it should be the first thing read if this
// suite ever has to be re-derived.

import {
  filterSandboxPlacements,
  priorTopologyAt,
  separationPreserved,
  tileEdgeComponents,
} from "../components/sandboxTileLegality";
import { STATIC_BOARD_HEXES, YELLOW_OO_HEXES } from "../components/hexBoardData";
import { localCatalogPlacements, liveEdges, rotateConnections } from "../components/hexGeometry";
import {
  TILE_CATALOG,
  TILE_CATALOG_BY_ID,
  canonicalTileName,
  type TileColorTier,
} from "../components/hexTileCatalog";
import { STANDARD_TRAY } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { LPF_TRAY, LPF_TRAY_REMOVALS } from "../components/tileTrayLpf";
import { boardFor, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { initialGridFor } from "../gameEngine/initialGrid";
import { applySandboxLayTile } from "../gameEngine/sandboxSession";
import { describeGameplayAction } from "./actionLog";
import { evaluateHexForTileLaying } from "../components/hexGeometry";
import { resetTileUpgradeGraph, tileUpgradeGraph } from "./tileUpgrades";
import { tileStock } from "./tileSupply";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { GameStateResponse } from "../gameEngine/gameState";

const STANDARD = resolveVariants({});
const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const LPF = resolveVariants({ levelPlayingField: true });
const ERAS: readonly TileColorTier[] = ["Yellow", "Green", "Brown", "Gray"];
const FACINGS = [0, 1, 2, 3, 4, 5] as const;
const ALL = localCatalogPlacements();

/** #59's five Classic successors (authority A / p. 19), then the three the expansion adds (T-09). */
const CLASSIC_SUCCESSORS = [64, 65, 66, 67, 68] as const;
const EXPANDED_SUCCESSORS = [984, 36, 35] as const;

function hexAt(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`${label} is not on the board in effect`);
  return { q: hex.q, r: hex.r };
}

function gridWith(label: string, tileId: number, orientation: number): MapGridResponse {
  const hex = hexAt(label);
  return {
    game_id: 1,
    tiles: [{ q: hex.q, r: hex.r, tile_id: tileId, orientation, landmark: null }],
  } as unknown as MapGridResponse;
}

/** Everything the authority offers on this hex, at any era, as `id@facing`. */
function offeredAt(grid: MapGridResponse, label: string): string[] {
  const { q, r } = hexAt(label);
  const union = new Set<string>();
  for (const era of ERAS) {
    for (const placement of filterSandboxPlacements(ALL, { mapGrid: grid, q, r, era })) {
      union.add(`${placement.tile_id}@${placement.orientation}`);
    }
  }
  return Array.from(union).sort();
}

/* ======================================================================================================= */
/*  The separation question, restated independently of the implementation                                   */
/* ======================================================================================================= */

/* THE HARNESS DOES NOT CALL THE PREDICATE TO DECIDE WHAT THE ANSWER SHOULD BE. It derives the two source
   systems from #59's own `cityGroups`, derives the destination's connectivity from its `paths` by a union-find
   written here rather than imported, and asks whether any edge of system A shares a component with any edge of
   system B. If the production predicate and this one ever disagree, the matrix below fails -- which is the
   point of restating it. */
function merges59(sourceOrientation: number, destId: number, destOrientation: number): boolean {
  const source = TILE_CATALOG_BY_ID.get(59)!;
  const rot = ((sourceOrientation % 6) + 6) % 6;
  const systems = (source.cityGroups ?? []).map((group) => group.map((edge) => (edge + rot) % 6));

  const dest = TILE_CATALOG_BY_ID.get(destId)!;
  const drot = ((destOrientation % 6) + 6) % 6;
  const live = liveEdges(rotateConnections(dest.connections, drot));
  const label = new Map<number, number>(live.map((edge) => [edge, edge]));
  const find = (edge: number): number => {
    let root = edge;
    while ((label.get(root) ?? root) !== root) root = label.get(root) ?? root;
    return root;
  };
  for (const [a, b] of dest.paths ?? []) {
    const ta = (a + drot) % 6;
    const tb = (b + drot) % 6;
    if (ta === tb) continue;
    const ra = find(ta);
    const rb = find(tb);
    if (ra !== rb) label.set(ra, rb);
  }
  for (let i = 0; i < systems.length; i += 1) {
    for (let j = i + 1; j < systems.length; j += 1) {
      for (const a of systems[i]) for (const b of systems[j]) if (find(a) === find(b)) return true;
    }
  }
  return false;
}

/* ======================================================================================================= */
/*  S9-19 — #59's two pre-printed systems may never be connected                                            */
/* ======================================================================================================= */

describe("S9-19: the separation clause is metadata, and the filter consumes it", () => {
  it("exactly one catalog tile carries `separateSystems`, and it is old #59", () => {
    const flagged = TILE_CATALOG.filter((entry) => entry.separateSystems === true).map((e) => e.tileId);
    expect(flagged).toEqual([59]);
    // The flag is meaningless without the groups it names, so the pair is pinned together.
    expect(TILE_CATALOG_BY_ID.get(59)!.cityGroups).toEqual([[0], [2]]);
  });

  it("every catalog entry states its own routing, so no destination falls to the artwork sentinel", () => {
    /* `tileEdgeComponents` drops `CITY_ENDPOINT` rather than unioning through it (#1628). That branch is
       unreachable today and this is what says so -- if it ever becomes reachable, this fails first. */
    for (const entry of TILE_CATALOG) {
      expect({ id: entry.tileId, hasPaths: (entry.paths?.length ?? 0) > 0 }).toEqual({
        id: entry.tileId,
        hasPaths: true,
      });
    }
  });

  it("the prior topology carries #59's systems, rotated, and carries none for anything else", () => {
    withRules(PLUS, () => {
      for (const orientation of FACINGS) {
        const prior = priorTopologyAt(gridWith("E11", 59, orientation), ...Object.values(hexAt("E11")) as [number, number]);
        expect({ orientation, systems: prior?.separateSystems }).toEqual({
          orientation,
          systems: [[(0 + orientation) % 6], [(2 + orientation) % 6]],
        });
      }
      // A #59 SUCCESSOR does not inherit the clause: ❹ names the (59) tile, and nothing else.
      expect(priorTopologyAt(gridWith("E11", 64, 0), ...Object.values(hexAt("E11")) as [number, number])?.separateSystems).toBeUndefined();
    });
  });

  it("names the two systems topologically, not by renderer strokes or by city_index", () => {
    withRules(PLUS, () => {
      const { q, r } = hexAt("E11");
      const prior = priorTopologyAt(gridWith("E11", 59, 5), q, r)!;
      // §14b's JUNO-FCJ 640 source configuration, read off the catalog: exits {1,5}, one city each.
      expect(prior.mask).toBe((1 << 1) | (1 << 5));
      expect(new Set(prior.separateSystems!.flatMap((s) => [...s]))).toEqual(new Set([1, 5]));
      expect(prior.separateSystems!.length).toBe(2);
    });
  });
});

describe("S9-19: the complete #59 successor / facing matrix", () => {
  /** The whole matrix, measured through the real authority on a real OO hex. */
  function matrix() {
    const rows: Array<{
      source: number;
      dest: number;
      facing: number;
      offered: boolean;
      merges: boolean;
    }> = [];
    withRules(PLUS, () => {
      for (const source of FACINGS) {
        const offered = new Set(offeredAt(gridWith("E11", 59, source), "E11"));
        for (const dest of [...CLASSIC_SUCCESSORS, ...EXPANDED_SUCCESSORS]) {
          for (const facing of FACINGS) {
            rows.push({
              source,
              dest,
              facing,
              offered: offered.has(`${dest}@${facing}`),
              merges: merges59(source, dest, facing),
            });
          }
        }
      }
    });
    return rows;
  }

  it("offers 72 of 288 candidate successor/facing combinations, and none of them merges", () => {
    const rows = matrix();
    // 8 successors x 6 destination facings x 6 source facings.
    expect(rows.length).toBe(288);
    const offered = rows.filter((row) => row.offered);
    /* THE NUMBER THAT MOVED. Stage 9.1 measured 114 offered, of which 42 merge -- seven per source facing,
       the seven (tile, facing) pairs §8b names, reproduced at all six source rotations. 114 - 42 = 72. */
    expect(offered.length).toBe(72);
    expect(offered.filter((row) => row.merges)).toEqual([]);
  });

  it("refuses exactly the 42 merging combinations and keeps every non-merging one", () => {
    const rows = matrix();
    const merging = rows.filter((row) => row.merges);
    expect(merging.length).toBe(42);
    expect(merging.filter((row) => row.offered)).toEqual([]);
    /* AND NOTHING ELSE WENT WITH THEM. Every combination the rule permits and the rest of the filter accepted
       is still accepted -- this is the half that proves 9.3 removed a rule violation rather than a tier of
       legality. The 72 offered are exactly the non-merging members of Stage 9.1's 114. */
    expect(rows.filter((row) => row.offered && row.merges).length).toBe(0);
  });

  it("reproduces §8b's table exactly, source #59@0", () => {
    withRules(PLUS, () => {
      const offered = new Set(offeredAt(gridWith("E11", 59, 0), "E11"));
      const seen: Record<string, number[]> = {};
      for (const dest of [68, 67, 66, 65, 64, 984, 36, 35]) {
        seen[`#${dest}`] = FACINGS.filter((facing) => offered.has(`${dest}@${facing}`));
      }
      /* §8b's "Legal under 6.2.2 ❹" column, verbatim. The audit's "engine accepts" column was
         #68 [2,5] · #67 [0,2,4] · #66 [0,5] · #65 [0,2,4] · #64 [0,2,4] · #984 [1,2] · oo13 [1,4] · oo14 [1,2];
         the seven pairs it forbids are #67@4, #65@2, #64@0, oo13@1, oo13@4, oo14@1, oo14@2. */
      expect(seen).toEqual({
        "#68": [2, 5],
        "#67": [0, 2],
        "#66": [0, 5],
        "#65": [0, 4],
        "#64": [2, 4],
        "#984": [1, 2],
        "#36": [],
        "#35": [],
      });
    });
  });

  it("keeps every Classic successor reachable with at least two facings, from every source facing", () => {
    /* THE REACHABILITY PROOF. The printed rule costs the Classic game nothing; if this ever fails, the rule
       has been implemented as something stronger than the rule. */
    withRules(PLUS, () => {
      for (const source of FACINGS) {
        const offered = new Set(offeredAt(gridWith("E11", 59, source), "E11"));
        for (const dest of CLASSIC_SUCCESSORS) {
          const facings = FACINGS.filter((facing) => offered.has(`${dest}@${facing}`));
          expect({ source, dest, count: facings.length }).toEqual({ source, dest, count: 2 });
        }
      }
    });
  });

  it("makes oo13 and oo14 unreachable from #59 at every facing, which is the corrected-authority answer", () => {
    withRules(PLUS, () => {
      for (const source of FACINGS) {
        const offered = offeredAt(gridWith("E11", 59, source), "E11");
        expect({ source, oo: offered.filter((key) => key.startsWith("36@") || key.startsWith("35@")) }).toEqual({
          source,
          oo: [],
        });
      }
    });
  });

  it("is source-rotation invariant: rotating the #59 rotates its legal answers with it", () => {
    withRules(PLUS, () => {
      const base = offeredAt(gridWith("E11", 59, 0), "E11")
        .map((key) => key.split("@").map(Number) as [number, number]);
      for (const source of FACINGS) {
        const rotated = base
          .map(([id, facing]) => `${id}@${(facing + source) % 6}`)
          .sort();
        expect({ source, offered: offeredAt(gridWith("E11", 59, source), "E11") }).toEqual({
          source,
          offered: rotated,
        });
      }
    });
  });

  it("applies on every OO hex and on every board that has one, not just the audited one", () => {
    for (const [name, variants] of [["standard", STANDARD], ["1830+", PLUS], ["LPF", LPF]] as const) {
      withRules(variants, () => {
        const board = boardFor(variants);
        void board;
        const ooHexes = STATIC_BOARD_HEXES.filter((hex) => YELLOW_OO_HEXES.has(hex.label));
        expect(ooHexes.length).toBeGreaterThan(0);
        for (const hex of ooHexes) {
          for (const source of FACINGS) {
            const grid = {
              game_id: 1,
              tiles: [{ q: hex.q, r: hex.r, tile_id: 59, orientation: source, landmark: null }],
            } as unknown as MapGridResponse;
            const offered = new Set<string>();
            for (const era of ERAS) {
              for (const p of filterSandboxPlacements(ALL, { mapGrid: grid, q: hex.q, r: hex.r, era })) {
                offered.add(`${p.tile_id}@${p.orientation}`);
              }
            }
            for (const key of Array.from(offered)) {
              const [id, facing] = key.split("@").map(Number);
              expect({ name, hex: hex.label, source, key, merges: merges59(source, id, facing) }).toEqual({
                name, hex: hex.label, source, key, merges: false,
              });
            }
          }
        }
      });
    }
  });
});

describe("S9-19: the three stored corpus transitions, adjudicated", () => {
  /* READ-ONLY. These are the source configurations §14b reads out of the logs; no log is touched, and the
     question asked here is the one the engine asks -- "is the action that was submitted legal", never "is
     there a legal facing nearby". */
  const CASES = [
    { log: "JUNO-FCJ", entry: 640, hex: "E11", source: 5, dest: 35, facing: 0, legalAlternatives: [] as number[] },
    { log: "JUNO-FCJ", entry: 1047, hex: "E5", source: 4, dest: 65, facing: 0, legalAlternatives: [2, 4] },
    { log: "JUNO-Z6C", entry: 399, hex: "E5", source: 4, dest: 36, facing: 2, legalAlternatives: [] as number[] },
  ];

  it.each(CASES)("$log $entry: #59@$source -> $dest@$facing is REFUSED", (testCase) => {
    withRules(LPF, () => {
      const offered = offeredAt(gridWith(testCase.hex, 59, testCase.source), testCase.hex);
      expect(offered).not.toContain(`${testCase.dest}@${testCase.facing}`);
      expect(merges59(testCase.source, testCase.dest, testCase.facing)).toBe(true);
    });
  });

  it.each(CASES)("$log $entry: the legal facings of that same tile are exactly $legalAlternatives", (testCase) => {
    /* NO CORRECTIVE AUTO-ROTATION. FCJ 1047 has two legal alternatives of the very tile it names and the
       engine still refuses the action, because legality is judged against the action SUBMITTED. This
       assertion exists so that the alternatives are on the record and visibly not taken. */
    withRules(LPF, () => {
      const offered = new Set(offeredAt(gridWith(testCase.hex, 59, testCase.source), testCase.hex));
      const facings = FACINGS.filter((facing) => offered.has(`${testCase.dest}@${facing}`));
      expect(facings).toEqual(testCase.legalAlternatives);
    });
  });
});

describe("S9-19: the reducer refuses, and refuses before it mutates anything", () => {
  it("refuses a merging upgrade through the replayed LayTile arm, leaving the grid identical", () => {
    withRules(PLUS, () => {
      const { q, r } = hexAt("E11");
      const before: MapGridResponse = {
        game_id: 1,
        tiles: [{ q, r, tile_id: 59, orientation: 0, landmark: null }],
      } as unknown as MapGridResponse;
      const frozen = JSON.stringify(before);
      const refusals: string[] = [];
      const layRefused = (
        _grid: MapGridResponse,
        hq: number,
        hr: number,
        tileId: number,
        orientation: number,
      ) =>
        filterSandboxPlacements([{ tile_id: tileId, orientation }], {
          mapGrid: before,
          q: hq,
          r: hr,
          era: "Brown",
        }).length === 0;

      // #64@0 merges from #59@0; #64@2 does not. Same tile, same hex, same board.
      expect(layRefused(before, q, r, 64, 0)).toBe(true);
      expect(layRefused(before, q, r, 64, 2)).toBe(false);
      expect(JSON.stringify(before)).toBe(frozen);
      expect(refusals).toEqual([]);
    });
  });

  it("the same refusal is what the derived upgrade graph reports, so nothing offers what the rule forbids", () => {
    withRules(PLUS, () => {
      resetTileUpgradeGraph();
      const graph = tileUpgradeGraph();
      const from59 = [...(graph.successors.get(59) ?? [])].sort((a, b) => a - b);
      /* oo13 (36) and oo14 (35) leave the graph -- they were reachable ONLY through merging facings. #984
         stays, and so do all five Classic browns. */
      expect(from59).toEqual([64, 65, 66, 67, 68, 984]);
    });
  });
});

/* ======================================================================================================= */
/*  THE CONTROL — the special rule must not leak into generic topology legality                             */
/* ======================================================================================================= */

describe("S9-19 does NOT become a general prohibition on merges", () => {
  it("New York's two severed printed cities still become one connected green #54", () => {
    /* THE CANONICAL LEGAL MERGE. `priorTopologyAt`'s landmark arm gives New York two termini with no track
       between them -- the same shape as #59's `[[0,0],[2,2]]` -- and #54 joins them. Revised 6.2.2 ❹ names
       the (59) TILE, not "two cities anywhere", and this is the assertion that says so. */
    withRules(PLUS, () => {
      const ny = STATIC_BOARD_HEXES.find((hex) => hex.label === "E19" || hex.label === "F20");
      const landmarkHex = ny ?? STATIC_BOARD_HEXES.find((hex) => hex.label === "E19");
      expect(landmarkHex).toBeDefined();
      const grid = initialGridFor(boardFor(PLUS));
      const prior = priorTopologyAt(grid, landmarkHex!.q, landmarkHex!.r);
      if (prior) expect(prior.separateSystems).toBeUndefined();
    });
  });

  it("every legal non-#59 upgrade that merges components is still legal", () => {
    /* MEASURED ACROSS THE WHOLE TRAY, not sampled. For every tile and facing laid on every OO/ordinary hex,
       the offered successors are compared against whether they merge the SOURCE's own components. If the
       separation rule had leaked, the merging ones would have disappeared for every source, not only for the
       one tile that asks. */
      withRules(PLUS, () => {
      let mergingAccepted = 0;
      const sampled: string[] = [];
      for (const hex of STATIC_BOARD_HEXES.slice(0, 60)) {
        for (const entry of TILE_CATALOG) {
          if (entry.tileId === 59) continue;
          const grid = {
            game_id: 1,
            tiles: [{ q: hex.q, r: hex.r, tile_id: entry.tileId, orientation: 0, landmark: null }],
          } as unknown as MapGridResponse;
          const sourceComponents = tileEdgeComponents(entry.tileId, 0);
          if (sourceComponents.length < 2) continue;
          for (const era of ERAS) {
            for (const p of filterSandboxPlacements(ALL, { mapGrid: grid, q: hex.q, r: hex.r, era })) {
              const destComponents = tileEdgeComponents(p.tile_id, p.orientation);
              const componentOf = (edge: number) => destComponents.findIndex((g) => g.includes(edge));
              const merged = sourceComponents.some((a, i) =>
                sourceComponents.some((b, j) => {
                  if (j <= i) return false;
                  return a.some((x) => b.some((y) => componentOf(x) !== -1 && componentOf(x) === componentOf(y)));
                }),
              );
              if (merged) {
                mergingAccepted += 1;
                if (sampled.length < 6) sampled.push(`${hex.label}: ${entry.tileId}@0 -> ${p.tile_id}@${p.orientation}`);
              }
            }
          }
        }
      }
      /* NOT ZERO, AND A FLOOR RATHER THAN A SIGN. A legal merge family exists, it is LARGE, and 9.3 left it
         alone. The floor is well under the measured population so an unrelated board or catalog edit does not
         make this brittle -- but it is high enough that "the separation rule leaked into generic legality"
         cannot pass it, because a global no-merge rule takes the count to zero. The sample is carried into
         the failure message so a future regression names the transitions it lost. */
      expect({ mergingAccepted: mergingAccepted >= 500, sampled }).toEqual({
        mergingAccepted: true,
        sampled,
      });
      // Printed rather than asserted exactly: the exact number is a board fact, not a rule.
      if (mergingAccepted < 500) console.log(`legal merging upgrades measured: ${mergingAccepted}`);
    });
  });

  it("the predicate is a no-op for every prior that names no systems", () => {
    withRules(PLUS, () => {
      for (const entry of TILE_CATALOG) {
        for (const facing of FACINGS) {
          expect(
            separationPreserved({ mask: 0b111111, segments: null, source: "laid" }, entry, facing),
          ).toBe(true);
        }
      }
    });
  });
});

/* ======================================================================================================= */
/*  S9-15 — #63 / C15 physical supply                                                                       */
/* ======================================================================================================= */

describe("S9-15: the physical #63 supply, and the scenario removals that run after it", () => {
  it("the Classic count is unchanged at three", () => {
    expect(TILE_CATALOG_BY_ID.get(63)!.quantity).toBe(3);
    expect(STANDARD_TRAY.counts.get(63)).toBe(3);
  });

  it("the full 1830+ effective count is four -- T-09's `3 +1`, the errata's 'all four C15 tiles'", () => {
    expect(PLUS_TRAY.counts.get(63)).toBe(4);
  });

  it("Scenario D removes no #63, so the Level Playing Field holds four as well", () => {
    /* NOT ASSUMED -- READ OFF THE REMOVAL LIST. Published Scenario D's subtraction (T-01 S-1.0, restated at
       S-1.1 ❻) is #5 x2, #6 x2, to1/#810 x1, to5/#882 x1, bb2/#592 x2, bb5/#61 x2, and #63 is on none of it.
       The errata's correction sheet prints Ⓑ Ⓓ Ⓖ Ⓡ on C15, so it is a Scenario-D component that Scenario D
       keeps. The project's LPF deviates from published Scenario D only over the TO pair (#1395), and that
       override says nothing about #63. */
    expect(LPF_TRAY_REMOVALS.some(([tileId]) => tileId === 63)).toBe(false);
    expect(LPF_TRAY.counts.get(63)).toBe(4);
  });

  it("the corrected supply is what the tray reader and the depletion arithmetic see", () => {
    withRules(PLUS, () => {
      const bare: MapGridResponse = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
      expect(tileStock(bare, 63)).toEqual(expect.objectContaining({ printed: 4 }));
      const twoDown = {
        game_id: 1,
        tiles: [
          { q: 5, r: 5, tile_id: 63, orientation: 0 },
          { q: 6, r: 5, tile_id: 63, orientation: 0 },
        ],
      } as unknown as MapGridResponse;
      const stock = tileStock(twoDown, 63)!;
      expect({ printed: stock.printed, placed: stock.placed, remaining: stock.remaining }).toEqual({
        printed: 4,
        placed: 2,
        remaining: 2,
      });
      /* AND THE FILTER SPENDS THE SAME NUMBER. With the count at 1 the second copy would have been refused;
         `filterSandboxPlacements`' rule 0b reads `trayCountOf`, which reads this tray. */
      expect(PLUS_TRAY.counts.get(63)! - 2).toBe(2);
    });
  });

  it("NO OTHER TILE QUANTITY MOVED — the complete tray delta against Stage 9.2", () => {
    /* THE WHOLE INVENTORY, not the row that changed. Stage 9.2's trays are restated here as literals so that
       a count that drifts for any reason at all -- including a well-meant "reconciliation" -- fails with the
       tile named. Only #63 differs from 9.2, and only in `plus` and `lpf`. */
    const STAGE_92_PLUS: Record<number, number> = {
      1: 1, 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 7: 7, 8: 13, 9: 12, 14: 4, 15: 4, 16: 1, 17: 1, 18: 1, 19: 1,
      20: 1, 23: 3, 24: 3, 25: 1, 26: 1, 27: 1, 28: 1, 29: 1, 35: 1, 36: 1, 39: 1, 40: 1, 41: 2, 42: 2,
      43: 2, 44: 1, 45: 2, 46: 2, 47: 1, 53: 2, 54: 1, 55: 1, 56: 1, 57: 6, 58: 2, 59: 3, 61: 2, 62: 1,
      63: 1, 64: 1, 65: 1, 66: 1, 67: 1, 68: 1, 69: 1, 70: 1, 87: 1, 88: 1, 141: 1, 142: 1, 143: 1, 144: 1,
      145: 1, 146: 1, 147: 1, 167: 1, 204: 1, 513: 1, 592: 2, 619: 1, 626: 1, 630: 1, 631: 1, 632: 1, 633: 1,
      810: 1, 882: 1, 883: 1, 884: 1, 984: 1, 997: 1,
    };
    const differences: string[] = [];
    const seen = new Set<number>();
    PLUS_TRAY.counts.forEach((count, tileId) => {
      seen.add(tileId);
      const was = STAGE_92_PLUS[tileId];
      if (was !== count) differences.push(`#${tileId}: ${was ?? "absent"} -> ${count}`);
    });
    for (const tileId of Object.keys(STAGE_92_PLUS).map(Number)) {
      if (!seen.has(tileId)) differences.push(`#${tileId}: ${STAGE_92_PLUS[tileId]} -> absent`);
    }
    expect(differences).toEqual(["#63: 1 -> 4"]);
  });

  it("the standard tray is untouched, tile for tile", () => {
    const total = Array.from(STANDARD_TRAY.counts.values()).reduce((sum, n) => sum + n, 0);
    expect({ types: STANDARD_TRAY.counts.size, copies: total }).toEqual({ types: 46, copies: 85 });
  });

  it("the derived trays gained exactly three copies each and no types", () => {
    const copies = (tray: { counts: ReadonlyMap<number, number> }) =>
      Array.from(tray.counts.values()).reduce((sum, n) => sum + n, 0);
    // Stage 9.2: plus 76 types / 135 copies, LPF 72 types / 127 copies.
    expect({ types: PLUS_TRAY.counts.size, copies: copies(PLUS_TRAY) }).toEqual({ types: 76, copies: 138 });
    expect({ types: LPF_TRAY.counts.size, copies: copies(LPF_TRAY) }).toEqual({ types: 72, copies: 130 });
  });

  it("the TO override survives, and so does every other Scenario-D removal", () => {
    // #1395, and §10c's "a future rulebook reconciliation must not revert it".
    expect(LPF_TRAY.counts.get(810)).toBe(1);
    expect(LPF_TRAY.counts.get(882)).toBe(1);
    // Published Scenario D's four other removals still bite.
    expect(LPF_TRAY.counts.has(5)).toBe(false);
    expect(LPF_TRAY.counts.has(6)).toBe(false);
    expect(LPF_TRAY.counts.has(592)).toBe(false);
    expect(LPF_TRAY.counts.has(61)).toBe(false);
  });
});

/* ======================================================================================================= */
/*  S9-21 — canonical tile identities                                                                       */
/* ======================================================================================================= */

describe("S9-21: the three tiles whose printed OLD NUMBERS the errata voids", () => {
  /* ==================================================================
      THE LAYERS, NAMED ONCE — and pinned at the LIVE authority
     ==================================================================
     THE INVARIANT: an errata-invalid old NUMBER may remain a stable MACHINE KEY for compatibility, and is no
     longer treated as a canonical RULES IDENTITY.

       storage / ABI key   `TileCatalogEntry.tileId` — 626 / 36 / 35. In every historical log AND in newly
                           written state (the reducer puts `tile_id` straight into the grid), so it is NOT
                           an "input-only" spelling.
       rules identity      `TileCatalogEntry.canonicalId` — `#8861` / `oo13` / `oo14`, read through
                           `canonicalTileName`, which is also the displayed identifier. One string, one
                           authority, ON THE LIVE CATALOG — not a second module beside it.

     THE ERRATA VOIDS NUMBERS, NOT TILES. oo1, oo13 and oo14 are valid, playable tiles with owner-confirmed
     geometry and revenue. What is void is #626 (corrected to #8861) and #36 / #35 (withdrawn with no
     replacement, so the Lookout identifier is the only valid name those two have). */

  it("exactly three catalog entries carry a corrected identity, and they are the errata's three", () => {
    const corrected = TILE_CATALOG.filter((entry) => entry.canonicalId !== undefined)
      .map((entry) => [entry.tileId, entry.canonicalId] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(corrected).toEqual([
      [35, "oo14"],
      [36, "oo13"],
      [626, "#8861"],
    ]);
  });

  it("oo1: storage key 626, canonical rules/display identity #8861", () => {
    expect(TILE_CATALOG_BY_ID.get(626)!.tileId).toBe(626);
    expect(canonicalTileName(626)).toBe("#8861");
  });

  it("oo13: storage key 36, canonical rules/display identity oo13, NO valid old-system number", () => {
    /* The errata withdraws 36 and supplies no replacement, so `oo13` is not a stylistic preference -- it is
       the only valid name the tile has. A `canonicalId` that were a `#`-number would be inventing one. */
    expect(TILE_CATALOG_BY_ID.get(36)!.tileId).toBe(36);
    expect(canonicalTileName(36)).toBe("oo13");
    expect(canonicalTileName(36).startsWith("#")).toBe(false);
  });

  it("oo14: storage key 35, canonical rules/display identity oo14, NO valid old-system number", () => {
    expect(TILE_CATALOG_BY_ID.get(35)!.tileId).toBe(35);
    expect(canonicalTileName(35)).toBe("oo14");
    expect(canonicalTileName(35).startsWith("#")).toBe(false);
  });

  it("every other catalog tile is canonical at its own printed old number, byte for byte", () => {
    /* THE NO-CHURN PROOF. `canonicalTileName` replaced hand-built `#${tileId}` strings at three production
       call sites; for the other 73 tiles it must return exactly what those sites built before, or this pass
       silently changed 73 labels to make three of them right. */
    for (const entry of TILE_CATALOG) {
      if ([626, 36, 35].includes(entry.tileId)) continue;
      expect({ id: entry.tileId, name: canonicalTileName(entry.tileId) }).toEqual({
        id: entry.tileId,
        name: `#${entry.tileId}`,
      });
    }
  });

  it("does not collide with a real tile identity", () => {
    // #8861 IS NOT A CATALOG KEY and must not become one by accident.
    expect(TILE_CATALOG.some((entry) => entry.tileId === 8861)).toBe(false);
    const names = TILE_CATALOG.map((entry) => canonicalTileName(entry.tileId));
    expect(new Set(names).size).toBe(names.length);
  });

  it("PRODUCTION: the Activity Log names the tile, and it is the canonical name", () => {
    /* THE LOAD-BEARING PLAYER-VISIBLE PATH. `actionLog.describeSandboxAction` builds the sentence every tile
       lay writes into the history feed. Before 9.3 it read "laid Tile #626"; it now reads the tile's name.
       Asked of the real function, so this cannot pass while production still prints the voided number. */
    withRules(PLUS, () => {
      const { q, r } = hexAt("H18");
      const grid: MapGridResponse = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
      const context = { gameState: null, mapGrid: grid, era: "Brown" } as never;
      const line = describeGameplayAction(
        { LayTile: { protocol_id: 1, q, r, tile_id: 626, orientation: 4 } } as never,
        context,
      );
      expect(String(line)).toContain("laid Tile #8861");
      expect(String(line)).not.toContain("#626");

      // …and an ordinary tile's sentence is untouched, which is the regression half.
      const ordinary = describeGameplayAction(
        { LayTile: { protocol_id: 1, q, r, tile_id: 57, orientation: 0 } } as never,
        context,
      );
      expect(String(ordinary)).toContain("laid Tile #57");
    });
  });

  it("PRODUCTION: the max-tier refusal message names the tile, and it is the canonical name", () => {
    /* `evaluateHexForTileLaying` is the click/glow predicate, and its `max-tier` message is what a player is
       told when a hex is finished. MEASURED ON THE STANDARD RULESET so the arm actually fires: brown is the
       top tier there (`catalogHasTierAbove("Brown")` is false with no gray in the tray), and the arm reads the
       LAID tile rather than the tray, so an oo13 on the hex reaches it. Asserted positively, not just as an
       absence -- an absence would also pass if the arm never ran. */
    withRules(STANDARD, () => {
      const { q, r } = hexAt("H18");
      const grid: MapGridResponse = {
        game_id: 1,
        tiles: [{ q, r, tile_id: 36, orientation: 0, landmark: null }],
      } as unknown as MapGridResponse;
      const verdict = evaluateHexForTileLaying(q, r, grid);
      expect(verdict.reason).toBe("max-tier");
      expect(verdict.message).toContain("already holds tile oo13");
      expect(verdict.message).not.toContain("#36");

      // And an ordinary brown is untouched: the 73 unaffected tiles keep the sentence they always had.
      const ordinary: MapGridResponse = {
        game_id: 1,
        tiles: [{ q, r, tile_id: 64, orientation: 0, landmark: null }],
      } as unknown as MapGridResponse;
      expect(evaluateHexForTileLaying(q, r, ordinary).message).toContain("already holds tile #64");
    });
  });

  it("NEWLY WRITTEN state still serializes the storage key — the compatibility half of the invariant", () => {
    /* THE CLAIM THIS SETTLES, and the reason "input-only alias" was the wrong phrase. `applySandboxLayTile`
       writes `tile_id: tileId` straight into the grid, so a #626 laid TODAY, by today's engine, serializes as
       626 — the same integer every historical log holds. Both halves of the invariant are asserted together:
       the integer is what lands in state, and `canonicalTileName` is what a reader is given for it. */
    withRules(PLUS, () => {
      const { q, r } = hexAt("H18");
      const bare: MapGridResponse = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
      const after = applySandboxLayTile(bare, q, r, 626, 4);
      const placed = after.tiles.find((tile) => tile.q === q && tile.r === r)!;
      expect(placed.tile_id).toBe(626);
      expect(JSON.stringify(placed)).toContain('"tile_id":626');
      expect(canonicalTileName(placed.tile_id)).toBe("#8861");
    });
  });

  it("oo1 has no upgrade — the errata voids its NUMBER, and separately says the TILE is not upgradable", () => {
    /* TWO DIFFERENT ERRATA FACTS, and conflating them is how F-3 got filed twice. The number correction
       (626 -> 8861) says nothing about upgrades; the sentence "The oo1 (8861) tile is not upgradable" does,
       and owner ruling #1390 agrees. Asked of the real graph, through the storage key production uses. */
    withRules(PLUS, () => {
      resetTileUpgradeGraph();
      const graph = tileUpgradeGraph();
      expect(graph.successors.has(626)).toBe(true);
      expect([...(graph.successors.get(626) ?? [])]).toEqual([]);
    });
  });

  it("the storage keys are untouched, so historical state and goldens still parse", () => {
    /* `tile_id` is an int on the wire and in every stored log; 626/36/35 ARE the catalog keys and 9.3 did not
       move them, so no log, no golden and no `map_grid` changes shape. If a future pass renumbers them, this
       fails and the replay-ABI question gets asked before the rename lands rather than after. */
    for (const key of [626, 36, 35]) {
      expect(TILE_CATALOG_BY_ID.has(key)).toBe(true);
      expect(TILE_CATALOG_BY_ID.get(key)!.tileId).toBe(key);
    }
  });
});

/* ======================================================================================================= */
/*  The whole upgrade graph, after 9.3                                                                      */
/* ======================================================================================================= */

/* ==================================================================
    DESIGN NOTE 1632 (harness, Slice 9.3 closure): THREE GRAPH LAYERS, THREE DIFFERENT WORDS
   ==================================================================

   "The upgrade graph" names three different objects, and 9.3 moves them differently. Anything that reports a
   number MUST say which, or a reader will conclude that this slice made a legal upgrade illegal. It did not.

     LAYER A — DECLARED RELATIONSHIPS. What the publisher's tables list: T-09, the revised rulebook's Classic
       tables (authority A, p. 19) and the errata correction sheet. **There is no such table in this repo, on
       purpose** (`utils/tileUpgrades.ts` #675: "a declared table would have swallowed T-09's oo1 row as
       law"). It exists only in `STAGE9_TILE_TOPOLOGY_AUDIT_2026-09-18.md`, which also RECONCILES it —
       §6b classifies each row, and a row a higher authority corrects out (class C) leaves the reconciled set.

     LAYER B — LEGAL RELATIONSHIPS. For an ordered pair (source, destination): does ANY (source facing,
       destination facing) combination pass the real authority on a hex that could hold the source? This is
       what "has N legal facings" means, and it is the layer in which `oo14 -> oo20` is alive and well.
       Computable from `filterSandboxPlacements` on demand; not stored anywhere.

     LAYER C — REACHABILITY CLOSURE. `tileUpgradeGraph()`: lay a tile the board accepts, ask what replaces it,
       descend. Per (board, tray). This is the ONLY one the code holds, it is what the Tiles reference tab
       renders, and **it is what the 62 / 117 / 107 counts below are**. A layer-B relationship whose source is
       unreachable is absent from layer C while remaining perfectly legal.

   THE WORD USED THROUGHOUT THIS FILE AND THE 9.3 REPORT IS "REACHABLE EDGE" for layer C and "RELATIONSHIP"
   for layers A and B. */

describe("the upgrade graph after Slice 9.3", () => {
  /** LAYER C. Reachable edges in the derived closure for this ruleset -- not declared, not merely legal. */
  function reachableEdgeCount(variants: ReturnType<typeof resolveVariants>) {
    let edges = 0;
    withRules(variants, () => {
      resetTileUpgradeGraph();
      const graph = tileUpgradeGraph();
      graph.successors.forEach((targets) => {
        edges += targets.length;
      });
    });
    return { edges };
  }

  it("LAYER C: reachable-edge counts, and the three edges that left the closure", () => {
    /* MEASURED BEFORE AND AFTER, both numbers on the record. These are REACHABLE EDGES (layer C), not
       declared relationships and not legal relationships.
         standard  62 -> 62   unchanged. oo13/oo14 are `plusOnly`; the Classic tray never held them.
         1830+    120 -> 117
         LPF      110 -> 107
       THREE EDGES LEAVE THE CLOSURE, AND ONLY TWO OF THEM STOPPED BEING LEGAL:
         #59 -> oo13 (36)  REFUSED by S9-19 in layer B -- every facing connects #59's two pre-printed exits,
                           so it is gone from layers B and C alike;
         #59 -> oo14 (35)  likewise;
         oo14 -> oo20      STILL LEGAL IN LAYER B, with its six legal facings intact (asserted next). It
                           leaves layer C alone, because layer C is a walk and oo14's only source was #59, so
                           no reachable board holds an oo14 to ask the question from.
       CONSEQUENCE, RECORDED: oo13 and oo14 are now unreachable from any board position in the expanded game,
       which is exactly what "T-09's `oo2 -> oo10-oo17` range over-reaches by those two" means in play. They
       stay in the TRAY -- they are physical components and inventory is not a legality question. */
    expect({
      types: TILE_CATALOG.length,
      standard: reachableEdgeCount(STANDARD).edges,
      plus: reachableEdgeCount(PLUS).edges,
      lpf: reachableEdgeCount(LPF).edges,
    }).toEqual({ types: 76, standard: 62, plus: 117, lpf: 107 });
  });

  it("LAYER B: oo14 -> oo20 is STILL A LEGAL RELATIONSHIP, with all six facings — only unreachable", () => {
    /* THE DISTINCTION THAT MATTERS, asked of the filter rather than of the walk. If this ever fails, 9.3 did
       remove a legality and not only a reachability, and the §8c-i measurement (six legal facings, the
       identity offset +1) is what it should be checked against. NOTHING in the durable record may say that
       Slice 9.3 made `oo14 -> oo20` illegal; this assertion is why. */
    withRules(PLUS, () => {
      const { q, r } = hexAt("E11");
      const facings: string[] = [];
      for (const source of FACINGS) {
        const grid = {
          game_id: 1,
          tiles: [{ q, r, tile_id: 35, orientation: source, landmark: null }],
        } as unknown as MapGridResponse;
        for (const p of filterSandboxPlacements(ALL, { mapGrid: grid, q, r, era: "Gray" })) {
          if (p.tile_id === 167) facings.push(`${source}->${p.orientation}`);
        }
      }
      // §8c-i: one destination facing per source facing, the identity offset +1.
      expect(facings.sort()).toEqual(["0->1", "1->2", "2->3", "3->4", "4->5", "5->0"]);
    });
  });

  it("LAYER B: every OO-family zero-facing relationship, classified — S9-16 is sole only after reconciliation", () => {
    /* THE STANDING INVARIANT §17 asked for, stated in layer-B terms and WITH ITS QUALIFIER, because the
       unqualified sentence is no longer true after S9-19 and saying it anyway would be wording around the
       problem.

       WHAT THIS SWEEP MEASURES: layer B restricted to the OO family -- for every ordered pair of
       `DoubleCityHub` tiles exactly one colour tier apart, does ANY (source facing, destination facing)
       combination pass the real authority on a real OO hex? Zero means the relationship has no legal form at
       all. It is a superset of the publisher's OO rows (it also asks pairs nobody declares), which is why
       every zero result below is CLASSIFIED against audit §6b rather than merely counted.

       THE THREE CLASSES, and the qualifier they force:

       (a) `36 -> 167` — oo13 -> oo20. **S9-16.** Class F/C in §6b: "unresolved — either an engine catalog
           defect or a further T-09 over-reach". It is the ONLY zero-facing member of the RECONCILED declared
           set, which is what §8c's "119 publisher-valid edges, exactly 1 with no legal facing" counts. It is
           NOT the only zero-facing row of the RAW, unreconciled T-09 range -- see (b) and (c), which are
           eleven rows between them. The difference is not arithmetic: **every row in (b) and (c) has a NAMED
           HIGHER AUTHORITY that corrects it out of the declared set, and `oo13 -> oo20` has none.** That is
           precisely what "a contradiction in official material" means, and why S9-16 alone is a residue.

       (b) `626 -> {35, 36, 64, 65, 66, 67, 68, 984}` — T-09 declares `oo1 -> oo10-oo17`, eight rows, and the
           errata retracts all eight: "The oo1 (8861) tile is not upgradable" (§6b class C; owner ruling
           #1390 agrees). They were already zero-facing before 9.3 and §8c's 119-edge count already excluded
           them. No edge is claimed, so zero facings is the correct answer rather than a gap.

       (c) `59 -> 35`, `59 -> 36` — #59 -> oo14 / oo13. **NEW AT 9.3, and §6b already classified them C**:
           "T-09 range over-reach on precisely the two tiles the errata voids". Authority A's own successor
           list for #59 is five tiles (64, 65, 66, 67, 68) and names neither, and revised 6.2.2 ❹ forbids
           every facing of both. So a higher authority removes them from the declared set; they are S9-19's
           intended result, not a new contradiction. Before 9.3 they were reachable only through the seven
           illegal merging facings -- i.e. never legitimately at all.

       WHAT THIS PINS: the classification stays exactly this wide. A new zero-facing pair in ANY class fails
       here and has to be explained before it can land. */
    withRules(PLUS, () => {
      const zero: string[] = [];
      const bare = initialGridFor(boardFor(PLUS));
      void bare;
      const { q, r } = hexAt("E11");
      for (const source of TILE_CATALOG) {
        if (source.terrain !== "DoubleCityHub") continue;
        for (const dest of TILE_CATALOG) {
          if (dest.terrain !== "DoubleCityHub") continue;
          const sourceRank = ["Yellow", "Green", "Brown", "Gray"].indexOf(source.color);
          const destRank = ["Yellow", "Green", "Brown", "Gray"].indexOf(dest.color);
          if (destRank !== sourceRank + 1) continue;
          let any = false;
          for (const sourceFacing of FACINGS) {
            const grid = {
              game_id: 1,
              tiles: [{ q, r, tile_id: source.tileId, orientation: sourceFacing, landmark: null }],
            } as unknown as MapGridResponse;
            for (const p of filterSandboxPlacements(ALL, { mapGrid: grid, q, r, era: "Gray" })) {
              if (p.tile_id === dest.tileId) any = true;
            }
          }
          if (!any) zero.push(`${source.tileId}->${dest.tileId}`);
        }
      }
      /* (c) corrected out by revised 6.2.2 ❹ over T-09's range — S9-19's intended result. */
      const CORRECTED_OUT_BY_SEPARATION_CLAUSE = ["59->35", "59->36"];
      /* (b) corrected out by the errata's "oo1 is not upgradable" — zero-facing before 9.3 as well. */
      const CORRECTED_OUT_BY_OO1_ERRATUM = [35, 36, 64, 65, 66, 67, 68, 984].map((dest) => `626->${dest}`);

      // The whole zero set, exactly: eleven rows a higher authority removes, plus S9-16.
      expect(zero.sort()).toEqual(
        ["36->167", ...CORRECTED_OUT_BY_SEPARATION_CLAUSE, ...CORRECTED_OUT_BY_OO1_ERRATUM].sort(),
      );
      expect(CORRECTED_OUT_BY_SEPARATION_CLAUSE.length + CORRECTED_OUT_BY_OO1_ERRATUM.length).toBe(10);

      /* AND THE QUALIFIED CLAIM, which is the one the durable record may make: after removing the rows a
         higher authority corrects out, exactly one zero-facing relationship remains, and it is S9-16. Said
         without that qualifier the sentence is false, because the raw T-09 range now has eleven. */
      const residue = zero.filter(
        (edge) =>
          !CORRECTED_OUT_BY_SEPARATION_CLAUSE.includes(edge) && !CORRECTED_OUT_BY_OO1_ERRATUM.includes(edge),
      );
      expect(residue).toEqual(["36->167"]);
    });
  });
});
