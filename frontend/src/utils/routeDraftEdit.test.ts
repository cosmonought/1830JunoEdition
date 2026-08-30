/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 882 (harness): THE FIRST TEST THESE RULES HAVE HAD
// ==================================================================
//
// `handleRouteHexClick` held seven rules about what a route is, and before this file NOT ONE was asserted --
// none of its refusal strings appeared in any harness. It was the densest rule-holder in `App.tsx` (84 lines,
// 29 decisions) and the least covered code in the app, which is not a coincidence: rules reachable only
// through a React state setter are rules only grep can check, and grep cannot tell you that clicking the
// last hex twice steps back exactly once.
//
// FOUND BY AUDIT, NOT BY REPORT. That is the point of extracting before the next bug rather than after it.

import { editRouteDraft, type RouteDraftEdit } from "./routeDraftEdit";
import { UNLIMITED_REACH } from "./trainReach";
import type { RoutePoint } from "./routeWaypoints";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { liveEdgesForHex } from "../components/hexGeometry";

/* ==================================================================
    DESIGN NOTE 1025: "ADJACENT" IS NOT "JOINED", AND THIS FIXTURE ASSUMED IT WAS
   ==================================================================
   THIS WAS A BARE BOARD, and its own note described A9 and A11 as "two adjacent preprinted termini ... the
   simplest legal two-stop route". They are adjacent. They are not JOINED: on a bare grid A9 carries one
   printed rail, reaching an edge that does not face A11, so no track runs between them.

   IT PASSED BECAUSE THE RULE IT WAS TESTING DID NOT EXIST. `editRouteDraft` rule 6 appended any adjacent
   click without asking whether a rail joined the two hexes -- which is precisely what was reported: "the UI
   will draw discontinuous bits of route as though that were legal." So this suite was pinning the bug, and
   several of its cases could only ever have exercised the rules they name once that hole was closed.

   THE FIX IS TO LAY THE TRACK THE FIXTURE ALWAYS CLAIMED. Tile 9 is the plain straight (edges 0-3), which is
   the minimum that makes each pair a corridor -- and the assertions below still check every property this
   file relied on, so a laid tile that changed one of them would say so rather than pass quietly. */
const GRID: MapGridResponse = {
  game_id: 1,
  tiles: [
    // A9 <-> A11 run east-west, as do A19 <-> A17.
    { q: 4, r: 0, tile_id: 9, orientation: 0 },
    { q: 5, r: 0, tile_id: 9, orientation: 0 },
    { q: 9, r: 0, tile_id: 9, orientation: 0 },
    { q: 8, r: 0, tile_id: 9, orientation: 0 },
  ],
} as MapGridResponse;

const at = (label: string): RoutePoint => {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no such hex ${label}`);
  return { q: hex.q, r: hex.r, hexLabel: label };
};

/* ==================================================================
    FIXTURES DERIVED FROM THE BOARD, NOT GUESSED
   ==================================================================
   The first draft of this file picked hexes by name and by `type === "Plain"`, and got two of them wrong:
   F18 and F20 carry no preprinted rails on a bare grid, so a test meant to exercise the CAP hit the
   no-track refusal instead and passed for the wrong reason -- and the hex chosen to BE trackless turned out
   to have preprinted track. A fixture that does not model what it claims proves nothing (`buyTrainsPanel`
   #837's fake-element lesson, in a new place).
   SO EACH ONE IS ASSERTED BELOW BEFORE IT IS USED. */

/** Two adjacent preprinted termini, both paying: the simplest legal two-stop route on a bare board. */
const START = at("A9");
const NEXT = at("A11");
/** A terminus with a live NON-terminus neighbour, for the rule that only the first click is gated. */
const FROM = at("A19");
const THROUGH = at("A17");
/** Genuinely blank cardboard -- found by asking, not by type. */
const BLANK = (() => {
  const hex = STATIC_BOARD_HEXES.find(
    (entry) => liveEdgesForHex(GRID, entry.q, entry.r).length === 0,
  );
  if (!hex) throw new Error("no blank hex on this board");
  return { q: hex.q, r: hex.r, hexLabel: hex.label };
})();

/* NARROWING HELPERS, because `if (result.ok) expect(...)` is a conditional expect -- and the lint rule is
   right about why: a test whose assertion sits behind a branch passes silently when the branch is not taken.
   These throw with the other arm's contents, so a wrong answer names itself. */
const pointsOf = (result: RouteDraftEdit): RoutePoint[] => {
  if (!result.ok) throw new Error(`expected an edit, got a refusal: ${result.reason}`);
  return result.points;
};
const refusalOf = (result: RouteDraftEdit): string => {
  if (result.ok) throw new Error(`expected a refusal, got ${result.points.length} points`);
  return result.reason;
};

const edit = (points: readonly RoutePoint[], click: RoutePoint, maxDistance?: number | null) =>
  editRouteDraft({
    mapGrid: GRID,
    points,
    click,
    displayLabel: click.hexLabel,
    maxDistance: maxDistance === undefined ? UNLIMITED_REACH : maxDistance,
  });

describe("where a route may start", () => {
  it("refuses a first click that is not a terminus", () => {
    /* #256/#264: a route runs between two revenue CENTRES, and a town is not one. The first click is refused
       outright; the last is left to the readout, because a player mid-draw has not finished yet. */
    const result = edit([], THROUGH);
    expect(refusalOf(result)).toContain("cannot START a route");
  });

  it("accepts a city as the first click", () => {
    const result = edit([], START);
    expect(pointsOf(result)).toEqual([START]);
  });

  it("only asks the question of the FIRST click", () => {
    /* THE ASYMMETRY THAT MAKES DRAWING POSSIBLE. If every click had to be a terminus, no route could pass
       through plain track -- which is most of the board. */
    const result = edit([FROM], THROUGH);
    expect(result.ok).toBe(true);
  });
});

describe("a waypoint needs track", () => {
  it("refuses a hex with no rails at all", () => {
    /* #186: `liveEdgesForHex` counts preprinted rails as well as laid tiles, so this refuses genuinely blank
       cardboard rather than "no tile yet". */
    expect(liveEdgesForHex(GRID, BLANK.q, BLANK.r)).toHaveLength(0);
    const result = edit([START], BLANK);
    expect(refusalOf(result)).toContain("has no track");
  });
});

describe("clicking the last hex again steps back", () => {
  it("removes exactly one point", () => {
    /* A QUICK ONE-STEP UNDO, not a no-op and not a rejected duplicate -- and the thing a grep-only test can
       never establish. */
    const route = [START, NEXT];
    const result = edit(route, NEXT);
    expect(pointsOf(result)).toEqual([START]);
  });

  it("empties a one-point route", () => {
    const result = edit([START], START);
    expect(pointsOf(result)).toEqual([]);
  });

  it("wins over the no-revisit rule", () => {
    /* ORDER MATTERS AND IS INVISIBLE. The last point IS on the route, so a revisit check placed first would
       refuse the step-back and the player could never undo. */
    const route = [START, NEXT];
    const result = edit(route, NEXT);
    expect(result.ok).toBe(true);
  });
});

describe("a route may not visit a hex twice", () => {
  it("refuses a hex already on the route", () => {
    // 1830 pays a hex once per pass, so drawing and pricing would disagree.
    const route = [START, NEXT];
    const result = edit(route, START);
    const reason = refusalOf(result);
    expect(reason).toContain("already on this route");
    // And it says what to do instead, naming the point that CAN be undone.
    expect(reason).toContain(NEXT.hexLabel);
  });
});

describe("the train's reach is enforced on what the click produces", () => {
  it("refuses the click that would overrun", () => {
    /* #624: checked on the COMMIT rather than per click, so a bridge's extra stops count. A 1-train cannot
       reach a second city. */
    const result = edit([START], NEXT, 1);
    expect(refusalOf(result)).toContain("it can only run 1");
  });

  it("caps the very first stop too", () => {
    /* A one-stop cap is not a state 1830 has; the check is uniform rather than special-cased, which is what
       keeps it honest for the Diesel (#624). */
    const result = edit([], START, 0);
    expect(result.ok).toBe(false);
  });

  it("never refuses a Diesel", () => {
    // #881: the sentinel, at the drawing end.
    const result = edit([START], NEXT, UNLIMITED_REACH);
    expect(result.ok).toBe(true);
  });

  it("treats an unknown train as unlimited for drawing", () => {
    /* #881's asymmetry: refusing on ignorance would stop a legal route with no explanation. The over-long
       FLAG reads the same unknown as the smallest train, which is the other end of the same rule. */
    const result = edit([START], NEXT, null);
    expect(result.ok).toBe(true);
  });
});

describe("adjacency and the bridge", () => {
  it("appends a neighbouring hex as-is", () => {
    /* #276: hex-by-hex drawing stays available for disambiguating a branch; the bridge only fills gaps the
       player chose to leave. */
    const result = edit([START], NEXT);
    expect(pointsOf(result)).toHaveLength(2);
  });

  it("refuses a gap it cannot bridge, with the reason", () => {
    /* A FAILED BRIDGE IS A REFUSAL, not a silent no-op -- the player asked for something specific and is
       owed an answer. Two distant cities on a bare board have no track between them. */
    const far = STATIC_BOARD_HEXES.find(
      (hex) => hex.cityDesignation && Math.abs(hex.q - 6) + Math.abs(hex.r - 6) > 6,
    );
    expect(far).toBeDefined();
    const result = edit([START], { q: far!.q, r: far!.r, hexLabel: far!.label });
    expect(refusalOf(result)).toMatch(/No track path|has no track/);
  });
});

describe("the shell kept only the plumbing", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  })();

  it("asks the rule instead of holding it", () => {
    expect(APP).toContain("editRouteDraft({");
    expect(APP).toContain("if (!edit.ok) {");
  });

  it("keeps no copy of any of the seven rules", () => {
    /* THE ABSENCES ARE THE ASSERTION, file-wide rather than at the call site -- which is how #881's fifth and
       sixth sites turned up. Each of these is one of the rules that moved. */
    expect(APP).not.toContain("cannot START a route");
    expect(APP).not.toContain("already on this route");
    expect(APP).not.toContain("No track path from");
    expect(APP).not.toContain("bridgeWaypoints(");
    expect(APP).not.toContain("axialHexDistance(");
    /* `isRouteTerminusHex` IS DELIBERATELY NOT ON THIS LIST. It is still called in `App.tsx`, for the
       `endsOffTerminus` FLAG on a finished draft -- a different rule about a different moment. Asserting its
       absence would have been the over-reach this file exists to avoid: proving a symbol left rather than
       proving a rule did. */
  });
});
