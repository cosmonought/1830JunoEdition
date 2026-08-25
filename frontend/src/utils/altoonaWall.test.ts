/** @jest-environment node */
//
// Altoona is PRR's home, so for everybody else it is a wall — unless the bow works. No DOM.
//
// ==================================================================
//  DESIGN NOTE 808 (harness): REPRODUCING THE WALL BEFORE MOVING IT
// ==================================================================
//
// REPORTED, in two halves that turned out to be one:
//   12)  "when a corporation tried to manually run through the tile, it showed the route going into and out of
//        the station (and counting its $10 revenue) rather than following the bypass ... when I clicked 'run
//        route' it spit back the error that Altoona is tokened out."
//   12a) "the auto-route did not select the highest value route ... it could have run Pittsburgh to Baltimore
//        (bypassing the tokened out Altoona) for $80 [but ran] Cleveland to Chicago for $70."
//
// THIS FILE WAS WRITTEN AS A REPRODUCTION FIRST, and the cases below are the same ones, inverted. Both
// symptoms were measured against the shipped board before a line of the fix existed, which is the only reason
// the diagnosis is a finding rather than a reading -- and one of the two measurements corrected me: I expected
// the tracer to refuse H12 outright and it returns `["H14","H12"]`, stopping dead there. See the case itself.
//
// WHY THE STAKES ARE HIGHER THAN A CORNER CASE. H12 is the PENNSYLVANIA'S HOME. The moment PRR places its
// home token, a one-slot city in the middle of the board is full for all seven other corporations for the
// rest of the game -- which is exactly why 1830 prints a bow around it. A bypass that does not work is not a
// missing flourish; it is a wall across the map that the rules say is not there.

import { autoTraceRoute } from "./routeAutoTrace";
import { routeBlockedCityReason } from "./routeWaypoints";
import { hexOffersBypass, withForcedBypass } from "./cityBypass";
import { reachableNetwork } from "./trackReach";
import { sandboxRouteBreakdown } from "./sandboxSession";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { printedArtwork, printedMarkersFor } from "../components/TileGraphics";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import type { MapGridResponse } from "../components/hexContractTypes";

const H12 = { q: 2, r: 7 };

/** The acting corporation is not the PRR, and PRR's token fills H12's only slot. */
const BLOCKS_H12: (q: number, r: number, city: number) => boolean = (q, r, city) =>
  q === H12.q && r === H12.r && city === 0;

describe("the board makes Altoona a wall", () => {
  it("puts a one-slot city on H12", () => {
    /* Read back rather than trusted -- the same discipline #737 used, and the reason its premise block exists.
       If H12 ever gains a second slot this whole report changes shape.
       The slot resolution is `App`'s `citySlotsAt` in miniature: a printed marker's own `slots`, defaulting to
       one where the artwork does not say. */
    expect(printedArtwork("H12")?.marker?.kind).toBe("city");
    const cities = printedMarkersFor("H12").filter((marker) => marker.kind === "city");
    expect(cities).toHaveLength(1);
    expect(cities[0]?.slots ?? 1).toBe(1);
  });

  it("makes it the Pennsylvania's home station", () => {
    /* THE REASON THIS IS PERMANENT. A one-slot city that a corporation is guaranteed to occupy on turn one is
       full for the other seven for the whole game -- which is why 1830 prints a bow around this one hex. */
    const home = STATION_HOME_HEXES.find((entry) => entry.q === H12.q && entry.r === H12.r);
    expect(home).toMatchObject({ label: "H12", companyId: 1 });
  });

  it("prints a bow around it", () => {
    // #737's premise, restated here because this file's whole argument rests on the bow existing.
    expect(printedArtwork("H12")?.bypassTracks).toEqual([1]);
  });
});

/* THE FIXTURE, and why it needs laying at all. On a bare board H12's neighbours have no track, so
   `neighbourAcross` returns null on every edge and the hex is an island -- measured, not assumed, which is
   what the first draft of this file got wrong: its control asserted a route existed and found none, and the
   reproduction underneath it was therefore proving nothing.
   Tile 57 on H10 and H14 gives the main line something to join at both ends. Both pay $20 as laid yellow
   track, so H14 -> H12 -> H10 is a real three-stop run worth $50, and the same run on the bow is $40 over two
   stops. That difference is the whole subject. */
const HEX = (label: string) => STATIC_BOARD_HEXES.find((hex) => hex.label === label)!;
const LAID = {
  tiles: [
    { q: HEX("H14").q, r: HEX("H14").r, tile_id: 57, rotation: 0 },
    { q: HEX("H10").q, r: HEX("H10").r, tile_id: 57, rotation: 0 },
  ],
} as unknown as MapGridResponse;

describe("the auto-tracer treats the bow as part of the wall", () => {
  const traceFromH14 = (blocks?: (q: number, r: number, city: number) => boolean) =>
    autoTraceRoute({
      mapGrid: LAID,
      era: "Yellow",
      startHexes: [[HEX("H14").q, HEX("H14").r]],
      maxRevenueCentres: 4,
      blocksThrough: blocks,
    });

  it("crosses H12 when nothing is tokened there", () => {
    /* THE CONTROL. If the tracer cannot reach H12 even unblocked, the case below proves nothing about
       blocking -- it would just be a board this fixture cannot route on. */
    const result = traceFromH14(undefined);
    expect(result.path.map((point) => point.hexLabel)).toEqual(["H14", "H12", "H10"]);
    expect(result.revenue).toBe(50);
  });

  it("goes round a full city instead of stopping dead at it", () => {
    /* THE REPORTED BUG, AND THE MEASUREMENT THAT CORRECTED ME. I expected the tracer to refuse H12 outright;
       before the fix it returned `["H14","H12"]` -- arriving, recording the run that ends there, and then
       refusing to go on. That is #730's terminus rule working exactly as designed, and it is what made the
       real defect visible: `blocksThrough` was asked on ARRIVAL, which is before the walk chooses WHICH WAY
       THROUGH, and the bow is a property of the way through.
       On the reported board this showed up as "the auto-route did not select the highest value route". It was
       not choosing badly; it was choosing from a board with a wall across the middle of it. */
    const blocked = traceFromH14(BLOCKS_H12);
    expect(blocked.path.map((point) => point.hexLabel)).toEqual(["H14", "H12", "H10"]);
  });

  it("prices the forced crossing as a bypass, not as a stop", () => {
    /* THE DISCRIMINATING ASSERTION, in #737's sense: the same three hexes must earn LESS when the middle one
       is crossed on the bow, because the bow pays nothing and spends no stop. A fix that merely let the walk
       through would produce the $50 through-run over a city the corporation may not enter. */
    const blocked = traceFromH14(BLOCKS_H12);
    expect(blocked.revenue).toBe(40);
    expect(blocked.path.find((point) => point.hexLabel === "H12")?.bypass).toBe(true);
  });

  it("still refuses the arm that enters the city", () => {
    /* #730's rule, unchanged and worth pinning: only the BOW is exempt. If this ever passes with a
       through-priced route, the fix has become "a full city stops blocking", which is a different and much
       worse change wearing this one's clothes. */
    const blocked = traceFromH14(BLOCKS_H12);
    expect(blocked.revenue).not.toBe(50);
  });
});

describe("the bow costs no stop, so a full train may still cross it (design note #821)", () => {
  /* ==================================================================
      A THIRD GATE, AND IT WAS NEVER ABOUT BLOCKING
     ==================================================================

     REPORTED after #808 and #820 both shipped: "the auto-route feature still stops a route at Altoona instead
     of bypassing it for a higher value final revenue center."

     #808 MOVED THE BLOCKING TEST INTO THE TRANSIT LOOP because the arm decides whether a full city is in the
     way. The CAPACITY test sat two lines above it with the identical mistake: `breakdown` prices the path
     with the current hex counted as a stop, and a hex crossed on the bow is not a stop -- #737's own words,
     "a bypassed hex pays nothing AND costs no stop -- the second is what makes the bow worth taking".
     So a train on its last stop arrived at Altoona and the gate refused to expand.

     AND THIS ONE IS NOT ABOUT TOKENS AT ALL, which is why the two previous passes walked past it: it happens
     on an unblocked board, so it applies to the PENNSYLVANIA -- the one corporation Altoona is never a wall
     for. Two bugs sharing a hex and nothing else.

     A 2-TRAIN IS THE WHOLE TEST. H14 and H10 pay $20 each and H12 pays $10, so with two stops to spend the
     choice is: stop at Altoona for $30, or cross it for free and finish at H10 for $40. */

  const H14 = HEX("H14");

  const traceWith = (maxRevenueCentres: number, blocks?: typeof BLOCKS_H12) =>
    autoTraceRoute({
      mapGrid: LAID,
      era: "Yellow",
      startHexes: [[H14.q, H14.r]],
      maxRevenueCentres,
      blocksThrough: blocks,
    });

  it("REGRESSION: a 2-train crosses rather than stopping on the $10", () => {
    const run = traceWith(2, BLOCKS_H12);
    expect(run.path.map((point) => point.hexLabel)).toEqual(["H14", "H12", "H10"]);
    expect(run.revenue).toBe(40);
  });

  it("does it for a corporation the city is open to", () => {
    /* THE HALF THAT PROVES IT IS NOT A BLOCKING BUG. With no `blocksThrough` at all the through arm is legal
       and pays $10 -- and a 2-train still cannot afford it, because spending its last stop there ends the run
       $10 short of where the bow ends it. */
    const run = traceWith(2, undefined);
    expect(run.revenue).toBe(40);
    expect(run.path.find((point) => point.hexLabel === "H12")?.bypass).toBe(true);
  });

  it("still takes the money when it has a stop to spare", () => {
    /* THE CONTROL, and the one that stops this becoming "always bypass". A 3-train can afford Altoona, and
       $50 beats $40 -- the bow is worth taking only when the stop it saves is worth more than the $10 it
       gives up. */
    const run = traceWith(3, undefined);
    expect(run.revenue).toBe(50);
    expect(run.path.find((point) => point.hexLabel === "H12")?.bypass).toBeFalsy();
  });

  it("does not spend a stop it has not got", () => {
    // A 1-train cannot make a two-centre run at all, which is 1830's minimum and not this gate's business.
    expect(traceWith(1, undefined).path).toEqual([]);
  });
});

describe("the network walk crosses on the bow too (design note #820)", () => {
  /* ==================================================================
      #808 FIXED ONE OF THE TWO WALKS AND #729 HAD ALREADY SAID WHY THAT IS NOT ENOUGH
     ==================================================================

     REPORTED: "during the Lay Track action, the corporation's veil and legal placement options are being
     blocked when its network reaches Altoona, despite the bypass."

     #730's note is explicit that these two walks travel together: "they had to be fixed together or the board
     would have promised reach the router then refused -- which is worse than both being wrong." #808 fixed
     the router and left the network, so the promise ran the other way: a train could cross Altoona and the
     board said the far side was unreachable.

     THE SAME MISTAKE IN THE SAME SHAPE. `blocksThrough` was asked on ARRIVAL and used to `continue`, dropping
     every exit -- and the bow is a property of the exit. */

  const H14 = HEX("H14");
  const H10 = HEX("H10");
  const key = (hex: { q: number; r: number }) => `${hex.q},${hex.r}`;

  it("reaches past a shut city that has a way round it", () => {
    const reach = reachableNetwork(LAID, [[H14.q, H14.r]], BLOCKS_H12);
    expect(reach.has(key(H12))).toBe(true);
    expect(reach.has(key(H10))).toBe(true);
  });

  it("keeps #729's rule for a hex with no bow", () => {
    /* THE CONTROL, and the assertion that stops this from being "blocking stopped working". A shut city with
       no way round is still reached and still not passed -- "the whole of the difference between a wall and a
       hole", in #729's words. H14 has a laid straight and no bypass arm, so blocking it must wall H12 off. */
    const blocksH14 = (q: number, r: number) => q === H14.q && r === H14.r;
    const reach = reachableNetwork(LAID, [[H10.q, H10.r]], (q, r) => blocksH14(q, r));
    expect(reach.has(key(H12))).toBe(true);
    expect(reach.has(key(H14))).toBe(true);
    expect(hexOffersBypass(LAID, H14.q, H14.r)).toBe(false);
  });

  it("is unaffected where nothing is shut", () => {
    // #737's compatibility case, one walk over: an unblocked board must reach exactly what it always did.
    const open = reachableNetwork(LAID, [[H14.q, H14.r]], undefined);
    const blocked = reachableNetwork(LAID, [[H14.q, H14.r]], BLOCKS_H12);
    expect(open.has(key(H10))).toBe(true);
    expect(blocked.size).toBeLessThanOrEqual(open.size);
  });
});

describe("the route is drawn on the arm it was priced on (design note #820)", () => {
  const read = (relative: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  };
  const CANVAS = read("components/hexCanvasPrimitives.ts");
  const APP = read("App.tsx");

  it("carries the variant to the overlay", () => {
    /* THE FOURTH SURFACE IN THIS FEATURE to be handed a hex and left to guess which of H12's two tracks was
       meant -- after the tracer (#808), the manual check (#808) and `RoutePoint` itself (#808). The report
       spotted it precisely: "it draws the route going directly through the tokened out city marker (it does
       not count the city/station toward the revenue)". The parenthesis is the tell -- priced on the bow,
       drawn on the station arm. */
    expect(APP).toContain("variants: points.map((point) => point.variant),");
    expect(CANVAS).toContain("variants?: readonly (number | undefined)[];");
  });

  it("asks for both arms rather than the collapsed first", () => {
    /* #225 collapses `printedPathsForTraversal` to the first way through, which is right for every hex on the
       board except this one. `printedTraversalVariants` is the un-collapsed answer #737 added and nothing
       outside the tests had ever called. */
    expect(CANVAS).toContain("printedTraversalVariants(printedLabel, entryEdge, exitEdge)[variant]");
  });

  it("falls back rather than failing", () => {
    // An absent variant, or one the artwork does not have, takes the collapsed answer -- which is what every
    // hex without a fork returns anyway, so nothing else on the board changes.
    expect(CANVAS).toContain("?? printedPathsForTraversal(printedLabel, entryEdge, exitEdge)");
  });

  it("still has two arms to choose between", () => {
    // The premise, read back: if H12 ever loses its second track this whole block stops meaning anything.
    expect(printedArtwork("H12")?.tracks).toHaveLength(2);
  });
});

describe("a hand-drawn route may cross on the bow too", () => {
  const DRAWN = [HEX("H14"), { q: H12.q, r: H12.r }, HEX("H10")];

  it("no longer refuses the route", () => {
    /* THE REPORTED REFUSAL: "when I clicked 'run route' it spit back the error that Altoona is tokened out."
       #730a tests interior hexes BY POSITION -- deliberately, and it wrote down why: "a drawn route is a list
       of hexes with no recorded entry side". It cannot ask which arm, so it assumed the one through the
       station. The bow clears the HEX, so the escape sits above the city loop rather than inside it. */
    expect(
      routeBlockedCityReason(DRAWN, BLOCKS_H12, () => "H12", (q, r) => hexOffersBypass(LAID, q, r)),
    ).toBeNull();
  });

  it("still refuses a wall with no way round it", () => {
    /* THE CONTROL, and the assertion that stops this from being "manual routes ignore blocking". A hex with
       no bow is exactly as impassable as it was. */
    const noBow = (q: number, r: number) => q === HEX("I15").q && r === HEX("I15").r;
    const acrossI15 = [HEX("H14"), HEX("I15"), HEX("H10")];
    expect(
      routeBlockedCityReason(acrossI15, noBow, () => "I15", (q, r) => hexOffersBypass(LAID, q, r)),
    ).toContain("tokened out");
  });

  it("prices the crossing as a bypass and spends no stop on it", () => {
    /* THE OTHER HALF OF THE REPORT: "it showed the route going into and out of the station (and counting its
       $10 revenue) rather than following the bypass." `withForcedBypass` is what the readout and the dispatch
       both apply, so they cannot disagree about what ran. */
    const marked = withForcedBypass(DRAWN, LAID, BLOCKS_H12);
    expect(marked[1]).toMatchObject({ bypass: true });
    const priced = sandboxRouteBreakdown(
      LAID,
      marked.map((point) => ({
        hex: STATIC_BOARD_HEXES.find((hex) => hex.q === point.q && hex.r === point.r)!.label,
        bypass: (point as { bypass?: boolean }).bypass,
      })),
      "Yellow",
    );
    expect(priced.revenue).toBe(40);
    expect(priced.stops.map((stop) => stop.hex)).not.toContain("H12");
  });

  it("leaves the ends alone, because a route that ends there stops there", () => {
    /* #730's terminus rule, as a property of the marking. You cannot bypass a centre you are terminating at,
       and a run INTO a shut city is still a legal run. */
    const ending = [HEX("H14"), { q: H12.q, r: H12.r }];
    expect(withForcedBypass(ending, LAID, BLOCKS_H12)[1]).not.toHaveProperty("bypass");
  });

  it("touches nothing on a board with no shut cities", () => {
    /* #737's compatibility case, restated for the marking: every other route in the game must come through
       this function byte-identical, or the change is not "Altoona works" but "routing changed". */
    expect(withForcedBypass(DRAWN, LAID, undefined)).toEqual(DRAWN);
    expect(withForcedBypass(DRAWN, LAID, () => false)[1]).not.toHaveProperty("bypass");
  });
});
