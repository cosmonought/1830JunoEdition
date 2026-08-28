/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 892 (harness): THE REPORTED GAME, REPLAYED FROM ITS OWN LOG
// ==================================================================
//
// REPORTED: "Something is definitely broken with auto-route on D trains. The auto-route gave me a $400 run
// but I was able to manually construct a run with the D train for $530 ... The autoroute chose to end the
// route at a $70 stop instead of continuing, shortchanging the corporation out of $190 on its route."
//
// AND THE PLAYER'S OWN GUESS WAS THE DIAGNOSIS: "I wonder in part if there is in fact a revenue center cap
// that has been imposed on D-trains." There was. `candidateRoutes` read
// `const cap = isUnlimitedReach(maxRevenueCentres) ? MAX_PATH_HEXES : maxRevenueCentres` -- a PATH LENGTH
// spent as a STOP BUDGET, both of them 14.
//
// THE FIRST VERSION OF THIS FILE ASSERTED THE WRONG THING AND ITS NEGATIVE CONTROL CAUGHT IT. It claimed the
// 25-hex run proved the 14-hex walk had refused the route, and asserted `revenue >= 520`. Reverting BOTH
// constants to 14 left all eight tests green: `candidateRoutes` joins two arms through the starting token,
// so the leash bounds each ARM and not the route, and the old code returned a 23-hex path worth exactly
// $520 -- the same figure the player reached by hand. An assertion that both sides satisfy measures nothing.
//
// WHAT THE CAPS COST IS THE STOP BUDGET, and it is worth $220 on this run: $520 before, $740 after. That is
// what the assertions below are written against, and reverting either constant now fails them.
//
// THE BOARD IS THE ONE THE REPORT HAPPENED ON, exactly. Room JUNO-Y8V's `sandbox_rooms/{code}/actions`
// subcollection was dumped to JSON and the `LayTile` / `PlaceHomeStation` / `PlaceStationToken` messages up
// to ERIE's own run are replayed here through the same functions the app uses. This is #522's rule taken
// literally -- the log is the game -- and it is a stronger fixture than any board written by hand.
//
// ------------------------------------------------------------------
//  TWO EARLIER ATTEMPTS AT THIS FIXTURE FAILED, AND BOTH ARE WORTH RECORDING
// ------------------------------------------------------------------
//
// FIRST, THE PASTED TEXT LOG. The human-readable line records the tile and the hex and NOT the facing --
// "B&O laid Tile #57 on J14" -- so a board rebuilt from it had every tile at orientation 0, nothing
// connected, and `autoTraceRoute` returned "No route found" at every capacity. The monotonicity test built
// on it passed six times over on `0 >= 0 >= 0`. It went green in three milliseconds, which is what prompted
// the check: a Phase-D board search that returns instantly has not searched.
//
// SECOND, A SYNTHETIC CORRIDOR. A line of tile 57 laid along a straight axial run returned a two-hex route
// at every capacity; a sweep of nine tile ids across all six rotations and all six directions found no
// corridor a route could walk at all. Laid track does not chain along a bare axial line the way the fixture
// assumed -- `altoonaWall.test.ts` records the same discovery from the other end.
//
// THE MESSAGE LOG HAS THE FACINGS, which is why this works and those did not. `orientation` is on the
// `LayTile` message and always was; it is the rendered sentence that is lossy.
//
// REVERTS ARE HONOURED THROUGH `effectiveActions`, not by taking the log at face value. This game contains
// seventeen `RevertTo` entries, three of them undoing tile lays -- a replay that ignored them would build a
// board the players never saw, and would do it silently.

import { applySandboxLayTile } from "./sandboxSession";
import { autoTraceRoute } from "./routeAutoTrace";
import { effectiveActions } from "./logRevert";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import type { MapGridResponse } from "../components/hexContractTypes";
import type { StationToken } from "./trackReach";

import FIXTURE from "./__fixtures__erieBoard.json";

/** ERIE's run at index 651, exactly as the message records it. */
const ERIE_RUN = [
  "F2", "G3", "G5", "F4", "E3", "D4", "E5", "E7", "D8", "D6", "C7", "C9", "D10",
  "E11", "D12", "D14", "D16", "D18", "E19", "F18", "G19", "F20", "F22", "F24", "E23",
];

/** The revenue the game recorded for it, from the run's own log line and the screenshot's chip row. */
const ERIE_HAND_BUILT = 520;

/** What the search returns once the stop budget is its own quantity. Pinned as a floor rather than an
 *  equality: an exhaustive search may legitimately improve, and a `toBe` here would fail the day it did. */
const ERIE_UNCAPPED_FLOOR = 700;

const ERIE_PROTOCOL_ID = 6;

/** The dump's shape, plus the two fields `RevertableAction` requires -- `effectiveActions` reads `index` to
 *  decide what a revert kills and `actor` to attribute it, and the dump carries both. `payload` is
 *  reconstituted from `msg` because the helper's type asks for it; nothing here reads it back. */
type Action = { index: number; actor: string | null; payload: string; msg: Record<string, unknown> };

/** The live log: every action the reverts did not kill, in index order. */
const LIVE: Action[] = effectiveActions(
  (FIXTURE.actions as ReadonlyArray<{ index: number; actor: string | null; msg: Record<string, unknown> }>).map(
    (a) => ({ index: a.index, actor: a.actor ?? "", payload: JSON.stringify(a.msg), msg: a.msg }),
  ),
);

/** The board ERIE ran on, built by replaying the lays through the reducer's own tile writer. */
const BOARD: MapGridResponse = (() => {
  let grid: MapGridResponse = { game_id: 0, tiles: [] } as unknown as MapGridResponse;
  for (const action of LIVE) {
    const lay = action.msg.LayTile as
      | { q: number; r: number; tile_id: number; orientation: number }
      | undefined;
    if (!lay) continue;
    /* `applySandboxLayTile` IS THE AUTHORITY, not a hand-rolled upgrade rule. It is what the shell calls, so
       an upgrade replaces its predecessor here exactly as it did in the game -- including any lay the
       reducer would have refused, which a fixture that just wrote the tile in would have accepted. */
    grid = applySandboxLayTile(grid, lay.q, lay.r, lay.tile_id, lay.orientation, () => false);
  }
  return grid;
})();

/** ERIE's station tokens, from the placements rather than from memory. */
const ERIE_TOKENS: StationToken[] = (() => {
  const out: StationToken[] = [];
  for (const action of LIVE) {
    const home = action.msg.PlaceHomeStation as
      | { company_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    const paid = action.msg.PlaceStationToken as
      | { protocol_id: number; q: number; r: number; city_index?: number | null }
      | undefined;
    if (home && home.company_id === ERIE_PROTOCOL_ID) {
      out.push(
        home.city_index == null ? [home.q, home.r] : [home.q, home.r, home.city_index],
      );
    }
    if (paid && paid.protocol_id === ERIE_PROTOCOL_ID) {
      out.push(
        paid.city_index == null ? [paid.q, paid.r] : [paid.q, paid.r, paid.city_index],
      );
    }
  }
  return out;
})();

describe("the fixture really is the reported board", () => {
  it("honours the reverts rather than replaying the raw log", () => {
    /* THE PREMISE. Seventeen reverts, and if `effectiveActions` ever stopped killing them this board would
       silently gain tiles the players took back. Asserted as a strict shrink so the check cannot pass on a
       no-op. */
    expect(FIXTURE.actions.length).toBeGreaterThan(LIVE.length);
    expect(LIVE.some((a) => "RevertTo" in a.msg)).toBe(false);
  });

  it("puts real tiles on the board", () => {
    /* A fixture that built an empty grid would make every route assertion below vacuous -- which is exactly
       how the first two attempts at this file failed. */
    expect(BOARD.tiles.length).toBeGreaterThan(30);
  });

  it("finds ERIE's two tokens", () => {
    // Its home on E11 and the station it bought on D14. Read from the log, not typed in.
    const labels = ERIE_TOKENS.map(([q, r]) => {
      const hex = STATIC_BOARD_HEXES.find((h) => h.q === q && h.r === r);
      return hex?.label;
    });
    expect(labels).toContain("E11");
    expect(labels).toContain("D14");
  });

  it("is the run the report is about", () => {
    expect(ERIE_RUN).toHaveLength(25);
  });
});

describe("a Diesel finds the run it was capped out of (design note #892)", () => {
  const trace = (maxRevenueCentres: number) =>
    autoTraceRoute({
      mapGrid: BOARD,
      era: "Brown",
      startHexes: ERIE_TOKENS,
      maxRevenueCentres,
    });

  it("beats the capped search, not merely the player", () => {
    /* THE ASSERTION THE NEGATIVE CONTROL DEMANDED. `>= 520` passed with the caps reverted, because the old
       code reached exactly $520 by joining two arms. Only a STRICT improvement over that figure separates
       the two, and the measured gap is large: $740 against $520.
       THE FLOOR IS $700 rather than $740 so a better search does not fail this, while leaving no room for
       the capped behaviour to slip back under it. */
    const diesel = trace(999);
    expect(diesel.revenue).toBeGreaterThan(ERIE_HAND_BUILT);
    expect(diesel.revenue).toBeGreaterThanOrEqual(ERIE_UNCAPPED_FLOOR);
  });

  it("spends more than fourteen stops", () => {
    /* THE MECHANISM, and it is the STOP BUDGET rather than the walk -- see the header for the measurement
       that corrected that. A Diesel handed fourteen stops banks its fourteenth and stops, which is the
       report's own "chose to end the route at a $70 stop instead of continuing". */
    const stops = trace(999).path.length;
    expect(stops).toBeGreaterThan(23);
  });

  it("keeps revenue non-decreasing as capacity grows", () => {
    /* THE PROPERTY THAT NEEDS NO ORACLE. Each train is the previous one with more budget, so revenue may
       only climb; the reported symptom is an inversion. Non-zero is asserted first, because this is the
       exact shape that passed vacuously on the text-log fixture. */
    const revenues = [2, 3, 4, 5, 6, 999].map((cap) => trace(cap).revenue);
    expect(revenues[0]).toBeGreaterThan(0);
    for (let i = 1; i < revenues.length; i += 1) {
      expect(revenues[i]).toBeGreaterThanOrEqual(revenues[i - 1]);
    }
  });

  it("returns within a bounded time on this Phase-D board", () => {
    /* THE RISK THE FIX INTRODUCES. The old caps existed because "a dense late-game board branches, and an
       unbounded DFS over it is exponential ... rather than a frozen tab", and this is that board. Generous
       on purpose: a regression guard against an accidental exponential, not a benchmark. */
    const started = Date.now();
    trace(999);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
