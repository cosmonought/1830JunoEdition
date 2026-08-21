// frontend/src/utils/tileUpgrades.test.ts
//
// ==================================================================
//  DESIGN NOTES 675 / 676 (harness): THE GRAPH, AND WHAT IT FOUND
// ==================================================================
//
// The upgrade graph is DERIVED -- it runs the board's own legality filter over
// the real map rather than reading a hand-written table. That buys immunity from
// drift and costs the usual price of derivation: the answers are not obvious by
// inspection, so they need pinning.
//
// THE CASES BELOW ARE THE ONES THAT WERE WRONG AT SOME POINT DURING THE BUILD,
// each preserved as the assertion that would have caught it:
//
//   THE GREEN TIER WAS ENTIRELY DEAD. Asking the bare board what is legal "at
//   the Green era" returns YELLOW tiles -- rule 4 wants exactly one tier above
//   what is there, and bare ground is rank -1 whatever era the room is in. So no
//   green tile was ever laid, none was ever asked what replaced it, and every
//   city tile reported a dead end. Uniform, confident, wrong.
//
//   NEW YORK WAS A DEAD END FOR A DIFFERENT REASON. The sweep laid tiles at
//   orientation 0, and `staysOnBoard` (#7) refuses a facing whose rail runs off
//   the map -- so #54 at G19 at 0 is a position that cannot occur, and the
//   filter correctly said nothing replaces it.
//
//   AND OO WAS A DEAD END BECAUSE THE GAME SAID SO. That one was not the
//   graph's bug: `preservesRouting` compared #59's terminus segments literally
//   and demanded every brown tile carry a self-loop. Design note #676. The graph
//   is what found it, which is the argument for deriving rather than authoring
//   in one sentence.

import { TILE_CATALOG_BY_ID } from "../components/hexTileCatalog";
import {
  isUpgradeDeadEnd,
  tileUpgradeGraph,
  tileUpgradeSources,
  tileUpgradeTargets,
} from "./tileUpgrades";

describe("the sweep", () => {
  it("covers the whole tray", () => {
    const graph = tileUpgradeGraph();
    expect(graph.successors.size).toBe(TILE_CATALOG_BY_ID.size);
    expect(TILE_CATALOG_BY_ID.size).toBe(46);
  });

  it("is cached, so a second ask is free", () => {
    // The sweep lays every tile on every hex. Once is fine; per render is not.
    expect(tileUpgradeGraph()).toBe(tileUpgradeGraph());
  });

  it("never proposes an upgrade that skips a tier", () => {
    /* THE INVARIANT UNDER EVERYTHING ELSE. Rule 4 is "exactly one step", so any
       edge spanning two tiers means the sweep laid a tile on a board the game
       could not have been in. */
    const rank = { Yellow: 0, Green: 1, Brown: 2 } as const;
    tileUpgradeGraph().successors.forEach((targets, from) => {
      const source = TILE_CATALOG_BY_ID.get(from);
      if (!source) return;
      for (const to of targets) {
        const target = TILE_CATALOG_BY_ID.get(to);
        expect(target).toBeDefined();
        expect(rank[target!.color]).toBe(rank[source.color] + 1);
      }
    });
  });

  it("gives no brown tile a successor", () => {
    /* Top tier. Nothing replaces it, and an edge out of one would mean the
       filter had been asked about a fourth colour that does not exist.
       Collected then asserted once, rather than an `expect` inside the branch:
       a conditional assertion passes silently when the condition never holds,
       so the count is asserted too. */
    const brown: number[] = [];
    const withSuccessors: number[] = [];
    TILE_CATALOG_BY_ID.forEach((entry, tileId) => {
      if (entry.color !== "Brown") return;
      brown.push(tileId);
      if (tileUpgradeTargets(tileId).length > 0) withSuccessors.push(tileId);
    });
    expect(brown.length).toBe(18);
    expect(withSuccessors).toEqual([]);
  });
});

describe("the city chain", () => {
  it("runs #57 to the two green cities", () => {
    // 1830's only yellow city tile, four copies against eight corporations.
    expect(tileUpgradeTargets(57)).toEqual([14, 15]);
  });

  it("runs both green cities to brown #63", () => {
    /* The case that exposed the dead green tier: before the walk descended
       properly, both of these reported nothing. */
    expect(tileUpgradeTargets(14)).toEqual([63]);
    expect(tileUpgradeTargets(15)).toEqual([63]);
  });

  it("reads backwards too", () => {
    expect(tileUpgradeSources(63)).toEqual([14, 15]);
    expect(tileUpgradeSources(14)).toEqual([57]);
  });
});

describe("the restricted families", () => {
  it("starts OO, Boston and New York on the BOARD, not in the tray", () => {
    /* Design note #675's headline. There is no yellow OO tile to look up
       because E5, D10, E11 and H18 come printed -- a tray view alone makes that
       read as a gap in the catalog. */
    const graph = tileUpgradeGraph();
    expect(graph.printedStarts.get("OO")).toEqual([59]);
    expect(graph.printedStarts.get("NY")).toEqual([54]);
    expect(graph.printedStarts.get("B")).toEqual([53]);
  });

  it("names the four OO hexes", () => {
    expect(graphHexes("OO")).toEqual(["D10", "E11", "E5", "H18"]);
  });

  it("carries OO through to brown", () => {
    /* DESIGN NOTE #676. Before that fix this was `[]`, and not as a rendering
       fault: `filterSandboxPlacements` is what the board asks, so all four OO
       hexes were frozen at green for the whole game. */
    expect(tileUpgradeTargets(59)).toEqual([64, 65, 66, 67, 68]);
  });

  it("carries New York through to brown", () => {
    // The orientation bug. #54 and #62 have identical segments; the sweep was
    // laying #54 at a facing G19 cannot hold.
    expect(tileUpgradeTargets(54)).toEqual([62]);
  });

  it("carries Boston through to brown", () => {
    expect(tileUpgradeTargets(53)).toEqual([61]);
  });

  it("keeps each restricted family to its own artwork", () => {
    /* Rule 3. The OO tile must never appear as a successor to a Boston or New
       York tile, or the reference would offer a lay the contract refuses. */
    expect(tileUpgradeTargets(53)).not.toContain(59);
    expect(tileUpgradeTargets(54)).not.toContain(59);
    expect(tileUpgradeSources(59)).toEqual([]);
  });
});

describe("dead ends", () => {
  it("calls the two-town tiles dead ends", () => {
    /* 1830 prints no green tile with two towns, so laying one of these fixes
       its hex at yellow for the rest of the game. Nobody would have authored
       this into a table; it falls out of centre parity. */
    for (const tileId of [1, 2, 55, 56, 69]) {
      expect(tileUpgradeTargets(tileId)).toEqual([]);
      expect(isUpgradeDeadEnd(tileId)).toBe(true);
    }
  });

  it("calls the one-town tiles dead ends", () => {
    // Same reason: no green town tile of any size exists in this tray.
    for (const tileId of [3, 4, 58]) {
      expect(isUpgradeDeadEnd(tileId)).toBe(true);
    }
  });

  it("does NOT call a brown tile a dead end", () => {
    /* "Nothing follows brown" and "nothing follows this" are different things
       to tell a player, and the panel says them differently. Brown is the top
       tier by design; a yellow dead end is a decision with a cost. */
    expect(tileUpgradeTargets(63)).toEqual([]);
    expect(isUpgradeDeadEnd(63)).toBe(false);
  });

  it("does not call plain track a dead end", () => {
    // The control. If the sweep broke, everything would report a dead end and
    // the assertions above would all still pass.
    for (const tileId of [7, 8, 9]) {
      expect(isUpgradeDeadEnd(tileId)).toBe(false);
      expect(tileUpgradeTargets(tileId).length).toBeGreaterThan(0);
    }
  });
});

function graphHexes(family: "OO" | "B" | "NY"): readonly string[] {
  return tileUpgradeGraph().printedHexes.get(family) ?? [];
}
