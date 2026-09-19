/** @jest-environment node */
// TEMPORARY Stage-9.3 baseline probe. Measurement only; replaced by the real suite.
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { localCatalogPlacements, rotateConnections, liveEdges } from "../components/hexGeometry";
import { TILE_CATALOG, TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import { initialGridFor } from "../gameEngine/initialGrid";
import { boardFor, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { LPF_TRAY } from "../components/tileTrayLpf";
import { STANDARD_TRAY } from "../components/tileTray";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { BoardDefinition } from "../components/hexBoardData";

const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const LPF = resolveVariants({ levelPlayingField: true });
const ALL = localCatalogPlacements();
const ERAS = ["Yellow", "Green", "Brown", "Gray"] as const;

const bare = (board: BoardDefinition): MapGridResponse => initialGridFor(board);
const hexAt = (label: string) => {
  const hex = STATIC_BOARD_HEXES.find((e) => e.label === label);
  if (!hex) throw new Error(`${label} missing`);
  return hex;
};

/** Connectivity classes of a tile's edges at an orientation, from `paths`. */
function components(tileId: number, orientation: number): number[][] {
  const entry = TILE_CATALOG_BY_ID.get(tileId)!;
  const rot = ((orientation % 6) + 6) % 6;
  const turn = (e: number) => (e + rot) % 6;
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    if (p !== x) { p = find(p); parent.set(x, p); }
    return p;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of liveEdges(rotateConnections(entry.connections, rot))) parent.set(e, e);
  for (const [a, b] of entry.paths ?? []) { const ta = turn(a), tb = turn(b); parent.set(ta, parent.get(ta) ?? ta); parent.set(tb, parent.get(tb) ?? tb); union(ta, tb); }
  const groups = new Map<number, number[]>();
  for (const e of Array.from(parent.keys())) {
    const root = find(e);
    groups.set(root, [...(groups.get(root) ?? []), e]);
  }
  return Array.from(groups.values()).map((g) => g.sort((a, b) => a - b));
}

/** #59's two source systems at a source orientation, as board edges. */
function sourceSystems59(sourceOrientation: number): number[][] {
  const entry = TILE_CATALOG_BY_ID.get(59)!;
  const rot = ((sourceOrientation % 6) + 6) % 6;
  return (entry.cityGroups ?? []).map((g) => g.map((e) => (e + rot) % 6).sort((a, b) => a - b));
}

/** Would this destination facing connect #59's two systems? */
function mergesSystems(sourceOrientation: number, destId: number, destOrientation: number): boolean {
  const systems = sourceSystems59(sourceOrientation);
  const comps = components(destId, destOrientation);
  const classOf = (edge: number) => comps.findIndex((c) => c.includes(edge));
  for (let i = 0; i < systems.length; i += 1) {
    for (let j = i + 1; j < systems.length; j += 1) {
      for (const a of systems[i]) for (const b of systems[j]) {
        const ca = classOf(a), cb = classOf(b);
        if (ca !== -1 && ca === cb) return true;
      }
    }
  }
  return false;
}

function acceptedOver59(hexLabel: string, sourceOrientation: number): string[] {
  const hex = hexAt(hexLabel);
  const grid: MapGridResponse = {
    game_id: 1,
    tiles: [{ q: hex.q, r: hex.r, tile_id: 59, orientation: sourceOrientation, landmark: null }],
  } as unknown as MapGridResponse;
  const union = new Set<string>();
  for (const era of ERAS) {
    for (const p of filterSandboxPlacements(ALL, { mapGrid: grid, q: hex.q, r: hex.r, era })) {
      union.add(`${p.tile_id}@${p.orientation}`);
    }
  }
  return Array.from(union).sort();
}

describe("STAGE-9.3 BASELINE PROBE", () => {
  it("dumps the #59 successor/facing matrix on the 1830+ tray", () => {
    withRules(PLUS, () => {
      const lines: string[] = [];
      let candidates = 0, accepted = 0, merging = 0;
      const perSuccessor = new Map<number, { legal: string[]; illegal: string[] }>();
      for (const so of [0, 1, 2, 3, 4, 5]) {
        const offered = acceptedOver59("E11", so);
        lines.push(`  #59@${so} -> [${offered.join(", ")}]`);
        for (const entry of TILE_CATALOG) {
          for (const dor of [0, 1, 2, 3, 4, 5]) {
            candidates += 1;
            const key = `${entry.tileId}@${dor}`;
            const isAccepted = offered.includes(key);
            if (!isAccepted) continue;
            accepted += 1;
            const bad = mergesSystems(so, entry.tileId, dor);
            const rec = perSuccessor.get(entry.tileId) ?? { legal: [], illegal: [] };
            (bad ? rec.illegal : rec.legal).push(`s${so}:${key}`);
            perSuccessor.set(entry.tileId, rec);
            if (bad) merging += 1;
          }
        }
      }
      console.log("=== #59 OFFERS (E11, plus tray, union of eras) ===");
      lines.forEach((l) => console.log(l));
      console.log("=== PER SUCCESSOR ===");
      Array.from(perSuccessor.entries()).sort((a, b) => a[0] - b[0]).forEach(([id, rec]) => {
        console.log(`  #${id}: legal=${rec.legal.length} illegal=${rec.illegal.length}`);
        console.log(`     legal:   ${rec.legal.join(" ")}`);
        console.log(`     ILLEGAL: ${rec.illegal.join(" ")}`);
      });
      console.log(`TOTALS candidates=${candidates} acceptedNow=${accepted} merging=${merging}`);

      // Fixed-source table, exactly as §8b states it (source @0).
      console.log("=== §8b TABLE REPRODUCTION, source #59@0 ===");
      const offered0 = acceptedOver59("E11", 0);
      for (const id of [68, 67, 66, 65, 64, 984, 36, 35]) {
        const acc = [0, 1, 2, 3, 4, 5].filter((o) => offered0.includes(`${id}@${o}`));
        const legal = acc.filter((o) => !mergesSystems(0, id, o));
        const illegal = acc.filter((o) => mergesSystems(0, id, o));
        console.log(`  #${id}: accepts=[${acc}] legal=[${legal}] illegalMerge=[${illegal}]`);
      }
      expect(true).toBe(true);
    });
  });

  it("dumps tray counts", () => {
    console.log("=== TRAY COUNTS ===");
    for (const [name, tray] of [["standard", STANDARD_TRAY], ["plus", PLUS_TRAY], ["lpf", LPF_TRAY]] as const) {
      const total = Array.from(tray.counts.values()).reduce((a, b) => a + b, 0);
      console.log(`  ${name}: types=${tray.counts.size} copies=${total} #63=${tray.counts.get(63) ?? "ABSENT"} #810=${tray.counts.get(810) ?? "ABSENT"} #882=${tray.counts.get(882) ?? "ABSENT"} #592=${tray.counts.get(592) ?? "ABSENT"} #61=${tray.counts.get(61) ?? "ABSENT"}`);
      console.log(`  ${name} FULL: ${JSON.stringify(Array.from(tray.counts.entries()).sort((a, b) => a[0] - b[0]))}`);
    }
    expect(true).toBe(true);
  });

  it("dumps the whole upgrade graph result", () => {
    for (const [name, variants] of [["standard", resolveVariants({})], ["1830+", PLUS], ["LPF", LPF]] as const) {
      withRules(variants, () => {
        const { resetTileUpgradeGraph, tileUpgradeGraph } = require("./tileUpgrades");
        resetTileUpgradeGraph();
        const graph = tileUpgradeGraph();
        let edges = 0;
        graph.successors.forEach((set: Set<number>) => { edges += set.size; });
        console.log(`  ${name}: tileTypes=${TILE_CATALOG.length} edges=${edges}`);
      });
    }
    // Explicit zero-facing probe for every catalog pair, plus tray.
    withRules(PLUS, () => {
      const board = boardFor(PLUS);
      void bare(board);
    });
    expect(true).toBe(true);
  });
});
