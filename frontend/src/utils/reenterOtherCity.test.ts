/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1399 (harness): A ROUTE MAY RE-ENTER A HEX BY ITS OTHER CITY
// ==================================================================
//
// REPORTED (JUNO-Z6C, B&O's D-train): "B&O's D-train is still showing a max revenue of $480 on Auto-Route.
// ... Auto-Route is bypassing H18 with tile 626 that has two separate cities", and the ruling: "each revenue
// center only counts once, so trains can re-enter hexes with multiple towns and cities so long as they aren't
// reusing track or revenue centers."
//
// THE ROUTER REFUSED ANY HEX TWICE; the pricing (#1318) and the hand-drawn builder had already moved to
// per-city. The fixture is the reported game -- every effective lay and token placement through B&O's Run
// Routes step, #892's discipline -- and the two figures below are the ones from the report: the $480 the
// router drew, and the route it now finds, which an exhaustive enumeration of every legal arm pair on this
// board (run once, offline, while making this change) confirms is the optimum.
//
// TWO CHANGES ARE PINNED. The walk keys visits by `hex:city`, so H18's second city may be entered once the
// first has been. And the second arm of a through-token route is searched AWAY from the first arm's centres
// rather than found freely and thrown out at the join -- which is what left the old route starting at the
// token instead of running through it.

import { applySandboxLayTile } from "./sandboxSession";
import { assignRouteSet } from "./routeAutoTrace";
import { UNLIMITED_REACH } from "./trainReach";
import { activateBoard, boardInEffect, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { initialGridFor } from "./initialGrid";
import { boardFor } from "./boardSelection";
import { resolveVariants } from "./gameVariants";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { StationToken } from "./trackReach";

import FIXTURE from "./__fixtures__z6cBoard.json";

const BO_PROTOCOL_ID = 4;
/** What the router drew on this board before #1399 -- the report's own figure, reproduced headlessly. */
const OLD_AUTO_ROUTE = 480;
/** What it draws now; a floor, as #892 pins its figure, since a search may legitimately improve. An
 *  exhaustive pairing of every legal arm (run offline, with the tokened-out cities walled as the shell walls
 *  them) puts the optimum at $780 -- Norfolk (L16) is a one-station city since #1401 and N&W's token makes it
 *  a terminus for B&O, which closes the Atlantic City loop that an earlier pass ran through. */
const NEW_AUTO_ROUTE_FLOOR = 780;

type Action = { index: number; actor: string | null; msg: Record<string, unknown> };
const ACTIONS = FIXTURE.actions as ReadonlyArray<Action>;

beforeAll(() => {
  const setup = ACTIONS.find((a) => a.msg.SetupGame)?.msg.SetupGame as { variants: Record<string, unknown> };
  activateBoard(boardFor(resolveVariants(setup.variants)));
});

const board = (): MapGridResponse => {
  // The expanded board opens with tiles already down (#1301), so the replay starts from its opening grid.
  let grid: MapGridResponse = initialGridFor(boardInEffect());
  for (const action of ACTIONS) {
    const lay = action.msg.LayTile as { q: number; r: number; tile_id: number; orientation: number } | undefined;
    if (!lay) continue;
    grid = applySandboxLayTile(grid, lay.q, lay.r, lay.tile_id, lay.orientation, () => false);
  }
  return grid;
};

const tokens = (): StationToken[] => {
  const out: StationToken[] = [];
  for (const action of ACTIONS) {
    const home = action.msg.PlaceHomeStation as
      | { company_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    const paid = action.msg.PlaceStationToken as
      | { protocol_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    if (home && home.company_id === BO_PROTOCOL_ID) {
      out.push(home.city_index == null ? [home.q, home.r] : [home.q, home.r, home.city_index]);
    }
    if (paid && paid.protocol_id === BO_PROTOCOL_ID) {
      out.push(paid.city_index == null ? [paid.q, paid.r] : [paid.q, paid.r, paid.city_index]);
    }
  }
  return out;
};

const labelOf = (q: number, r: number) => STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r)?.label ?? `${q},${r}`;

describe("B&O's D-train on JUNO-Z6C (design note #1399)", () => {
  it("the fixture is the reported board: 626 sits on H18 and B&O has its tokens", () => {
    const grid = board();
    const h18 = STATIC_BOARD_HEXES.find((h) => h.label === "H18")!;
    expect(grid.tiles.find((t) => t.q === h18.q && t.r === h18.r)?.tile_id).toBe(626);
    expect(tokens().length).toBeGreaterThan(0);
  });

  it("runs through the token and re-enters a two-stop hex by its other stop, well past the old $480", () => {
    const grid = board();
    const result = assignRouteSet({
      mapGrid: grid,
      era: "Gray",
      startHexes: tokens(),
      companyId: BO_PROTOCOL_ID,
      blocksThrough: (q, r) => labelOf(q, r) === "L16", // Norfolk: N&W's one-station home, shut to B&O
      trains: [{ trainIndex: 0, maxRevenueCentres: UNLIMITED_REACH }],
    });
    const run = result.assignments.find((a) => a.trainIndex === 0);
    expect(run).toBeDefined();
    expect(run!.revenue).toBeGreaterThan(OLD_AUTO_ROUTE);
    expect(run!.revenue).toBeGreaterThanOrEqual(NEW_AUTO_ROUTE_FLOOR);

    const labels = run!.path.map((p) => labelOf(p.q, p.r));
    // G17 (tile 631, two towns) is stood in twice -- once per town: the second report on this note was the
    // route refusing G17's other town. (H18's second city is only reachable through Norfolk, a wall here.)
    expect(labels.filter((l) => l === "G17").length).toBe(2);
    // No one-stop hex is: every other label appears once.
    const counts = new Map<string, number>();
    labels.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1));
    Array.from(counts.entries())
      .filter(([label]) => label !== "H18" && label !== "G17")
      .forEach(([, n]) => expect(n).toBe(1));
  });

  it("still refuses the same city twice: a one-city hex never repeats", () => {
    // The visit key is `hex:city`; `cityForArrival` names a city only on a two-city hex. Pinned as source
    // because the property is the rule itself rather than one board's outcome.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const src = fs.readFileSync(path.join(__dirname, "routeAutoTrace.ts"), "utf8");
    expect(src).toContain("if (visits.has(nextKey) || avoidVisits?.has(nextKey)) continue;");
    expect(src).toContain("const stop = arrivalEdge === null ? (startCity ?? 0) : stopForArrival(mapGrid, q, r, arrivalEdge);");
    // And the second arm searches away from the first arm's centres, the start excepted.
    expect(src).toContain("const avoid = new Set(armA.visits);");
    expect(src).toContain("avoid.delete(startKey);");
  });
});

/* ==================================================================
    DESIGN NOTE 1408 (harness): THE BEST ARMS DOWN EACH WAY OUT
   ==================================================================
   REPORTED (ERIE's D-train, OR 9.3): "It could be running through both cities in TO before going to ERIE's
   home hex and then off to Kingston." Router: $570, starting AT the home. Exhaustive pairing: $640 --
   D10 (Toronto's far city) -> C9 -> C11 -> D10 (near city) -> E11 (home) -> E13 -> the long southern run.
   Every kept first arm left E11 through Toronto, so the second arm could never take the Toronto loop; the
   first arm is now searched once per exit edge of the token's city. */
import ERIE_FIXTURE from "./__fixtures__z6cErie.json";

describe("ERIE's D-train on JUNO-Z6C, OR 9.3 (design note #1408)", () => {
  const ERIE_PROTOCOL_ID = 6;
  const ERIE_ACTIONS = ERIE_FIXTURE.actions as ReadonlyArray<Action>;
  const erieBoard = (): MapGridResponse => {
    let grid: MapGridResponse = initialGridFor(boardInEffect());
    for (const action of ERIE_ACTIONS) {
      const lay = action.msg.LayTile as { q: number; r: number; tile_id: number; orientation: number } | undefined;
      if (!lay) continue;
      grid = applySandboxLayTile(grid, lay.q, lay.r, lay.tile_id, lay.orientation, () => false);
    }
    return grid;
  };
  /** As the replayed state holds them: the home went down in city 1 and an upgrade's token map (#880) moved
   *  it to city 0, which the placement message alone cannot say. */
  const erieTokens = (): StationToken[] => ERIE_FIXTURE.tokensForErie as unknown as StationToken[];

  /** The walls the shell raised (#730) at that point -- `cityBlockerFor`'s own answers, dumped into the
   *  fixture beside the lays, so the test asks the router the question the table asked. */
  const WALLS = ERIE_FIXTURE.blockedForErie as ReadonlyArray<{ q: number; r: number; city: number }>;
  const erieWalls = () => (q: number, r: number, city: number) =>
    WALLS.some((wall) => wall.q === q && wall.r === r && wall.city === city);

  it("runs through both Toronto cities and its own home rather than starting at the home", () => {
    const grid = erieBoard();
    const result = assignRouteSet({
      mapGrid: grid,
      era: "Gray",
      startHexes: erieTokens(),
      companyId: ERIE_PROTOCOL_ID,
      blocksThrough: erieWalls(),
      trains: [{ trainIndex: 0, maxRevenueCentres: UNLIMITED_REACH }],
    });
    const run = result.assignments.find((a) => a.trainIndex === 0)!;
    expect(run.revenue).toBeGreaterThanOrEqual(640);
    const labels = run.path.map((p) => labelOf(p.q, p.r));
    expect(labels.filter((l) => l === "D10").length).toBe(2);
    // The home is passed THROUGH: it is neither the first nor the last hex.
    const homeAt = labels.indexOf("E11");
    expect(homeAt).toBeGreaterThan(0);
    expect(homeAt).toBeLessThan(labels.length - 1);
  });
});
