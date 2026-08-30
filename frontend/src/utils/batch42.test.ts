/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1023 (harness): THE MANUAL BRIDGE CROSSES ALTOONA
// ==================================================================
//
// REPORTED: "When trying to route C&O past Altoona, the router snaps to the tokened-out PRR city and throws an
// error. Worse, it completely refuses to draw a path along the bypass track, no matter which adjacent hexes
// the player clicks to force it."
//
// H12 IS THE PENNSYLVANIA'S HOME AND A ONE-SLOT CITY, so from the moment the PRR floats the middle of the
// board is walled for the other seven corporations -- which is why 1830 prints a bow around this one hex, and
// why a bow the router cannot take is not a missing flourish. #808 said all of that and fixed the two walks it
// found; the MANUAL bridge is the third.
//
// EVERY CASE HERE RUNS THE REAL PATHFINDER OVER THE REAL BOARD. H12's bow is PRINTED, so the hex under test
// needs no tile and deliberately gets none -- these cases cannot pass by agreeing with a hand-built graph of
// the one thing they are about. Its two neighbours DO get a plain straight each, for the reason the fixture's
// own note gives: a walk crosses only an edge both sides carry rail to, and bare cardboard carries none.
// (The first draft of this header claimed no tiles were used at all. That was written before the fixture
// needed them and left standing after it did, which is this codebase's signature failure appearing in its own
// harness -- corrected here rather than quietly.)
//
// AND THE REPORT'S ITEM 3 IS THE LAST DESCRIBE: the crossing the bridge proposes is fed to the SUBMIT-PATH
// validator, because "routes without triggering a validation error" is a claim about both halves and either
// alone was internally consistent all through the bug.

export {};

const { bridgeWaypoints } = require("./routeAutoTrace") as typeof import("./routeAutoTrace");
const { editRouteDraft } = require("./routeDraftEdit") as typeof import("./routeDraftEdit");
const { routeBlockedCityReason } =
  require("./routeWaypoints") as typeof import("./routeWaypoints");
const { withForcedBypass, hexOffersBypass } =
  require("./cityBypass") as typeof import("./cityBypass");
const { cityBlockerFor } = require("./cityBlocking") as typeof import("./cityBlocking");
const { cityEnteredFrom } = require("./trackReach") as typeof import("./trackReach");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { STATION_HOME_HEXES } =
  require("../components/hexContractTypes") as typeof import("../components/hexContractTypes");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");

/** The reported hexes, FOUND rather than typed -- #686's rule about coordinates written by hand. */
const H12 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H12")!;
const H14 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H14")!;
const H10 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H10")!;

/** PRR and C&O by their real ids, from the table the game uses. */
const PRR = STATION_HOME_HEXES.find((home) => home.label === "H12")!.companyId;
const CO = STATION_HOME_HEXES.find((home) => home.label === "F6")!.companyId;

/* ==================================================================
    THE CORRIDOR, LAID -- AND WHY THE BARE BOARD WAS NOT ENOUGH
   ==================================================================
   Altoona's bow is PRINTED, so H12 needs no tile and deliberately gets none: the hex under test is the real
   one, exactly as the board ships it. Its neighbours are bare cardboard, though, and a walk only crosses an
   edge both sides carry rail to -- so the first draft of this file asked the bridge to cross from one empty
   hex to another and got `null` for every case, blocker or not. That failure was the fixture's, not the
   router's, and the control that had no blocker at all is what said so.
   TILE 9 IS THE PLAIN STRAIGHT (edges 0-3), one either side, which is the minimum that makes H14 -> H12 -> H10
   a corridor rather than three unconnected hexes. */
const BARE = {
  game_id: 1,
  tiles: [
    { q: H14.q, r: H14.r, tile_id: 9, orientation: 0 },
    { q: H10.q, r: H10.r, tile_id: 9, orientation: 0 },
  ],
} as never;

/** The real predicate, on the real board: the PRR's home token fills Altoona's only slot, and C&O is acting. */
const blocksThrough = cityBlockerFor({
  actingCompanyId: CO,
  companies: [{ company_id: PRR, station_token_hexes: [[H12.q, H12.r]] }],
  // Altoona prints one station circle.
  slotsAt: (q, r, city) => (q === H12.q && r === H12.r && city === 0 ? 1 : 0),
  cityOf: () => 0,
});

const point = (hex: { q: number; r: number; label: string }) => ({
  q: hex.q,
  r: hex.r,
  hexLabel: hex.label,
});

describe("the board really is the reported one", () => {
  /* THE FIXTURE'S ASSUMPTIONS. Every case below is vacuous if Altoona has no bow or is not actually shut --
     and a vacuous pass is this project's most frequent failure mode. */
  it("prints a bow around Altoona", () => {
    expect(hexOffersBypass(BARE, H12.q, H12.r)).toBe(true);
  });

  it("shuts Altoona's station against C&O and not against the PRR", () => {
    expect(blocksThrough(H12.q, H12.r, 0)).toBe(true);
    const forPrr = cityBlockerFor({
      actingCompanyId: PRR,
      companies: [{ company_id: PRR, station_token_hexes: [[H12.q, H12.r]] }],
      slotsAt: () => 1,
      cityOf: () => 0,
    });
    // Rule 2: a corporation is never walled by a city it occupies.
    expect(forPrr(H12.q, H12.r, 0)).toBe(false);
  });

  it("puts H14 and H10 either side of it", () => {
    expect(Math.abs(H14.q - H12.q) + Math.abs(H10.q - H12.q)).toBe(2);
    expect(H14.r).toBe(H12.r);
    expect(H10.r).toBe(H12.r);
  });
});

describe("the bridge crosses a shut Altoona by its bow", () => {
  it("finds a path at all", () => {
    /* THE REPORT'S HEADLINE -- "it completely refuses to draw a path". A `null` bridge is the refusal the
       player was seeing, so this is the first thing to assert and the last thing to trust on its own. */
    const path = bridgeWaypoints(BARE, point(H14), point(H10), new Set(), blocksThrough);
    expect(path).not.toBeNull();
  });

  it("routes THROUGH Altoona rather than around the board", () => {
    /* A PATH IS NOT ENOUGH: a walk that fled the length of the board would also be non-null and would also be
       useless. The bow is the short way, and it is the way the player clicked for. */
    const path = bridgeWaypoints(BARE, point(H14), point(H10), new Set(), blocksThrough)!;
    expect(path.map((hex) => hex.hexLabel)).toContain("H12");
  });

  it("marks the crossing as a bypass", () => {
    /* THE HALF THAT WAS BEING THROWN AWAY. `TracedHex` has carried `bypass` since #737 and this walk emitted
       `{ q, r, hexLabel }` -- so even a crossing that had taken the bow was recorded, priced and validated as
       a crossing through the station. */
    const path = bridgeWaypoints(BARE, point(H14), point(H10), new Set(), blocksThrough)!;
    const altoona = path.find((hex) => hex.hexLabel === "H12");
    expect(altoona?.bypass).toBe(true);
  });

  it("still crosses for a corporation the city is open to", () => {
    /* THE CONTROL. A fix that simply refused Altoona to everybody would pass every case above. The PRR may run
       through its own station, and nothing here should stop it. */
    const forPrr = cityBlockerFor({
      actingCompanyId: PRR,
      companies: [{ company_id: PRR, station_token_hexes: [[H12.q, H12.r]] }],
      slotsAt: () => 1,
      cityOf: () => 0,
    });
    const path = bridgeWaypoints(BARE, point(H14), point(H10), new Set(), forPrr)!;
    expect(path.map((hex) => hex.hexLabel)).toContain("H12");
  });

  it("keeps the two arms as distinct states, though nothing on this board can tell", () => {
    /* ==================================================================
       A NEGATIVE CONTROL PASSED HERE, AND THIS IS THE HONEST ACCOUNT
       ==================================================================
       Collapsing the state key back to `(q, r, arrivalEdge)` -- dropping `variant`, which is half of what
       "graph the bow as a distinct edge" means -- left every case in this file green.

       THE REASON IS THE SHIPPED BOARD. Altoona's two arms join the SAME two edges, so once the shut-city
       filter has run only one transit survives and there is nothing for the key to disambiguate. Where both
       survive -- an unblocked hex -- they cost the same, so whichever `traversalsFrom` yields first wins
       either way. No board state distinguishes them, and `hexBoardData` has exactly one hex with two arms.

       THE KEY STAYS, and this is the argument rather than a claim that it is load-bearing today. `variant`
       is what makes the graph able to REPRESENT two ways through one hex; without it a future tile whose arms
       have different exit edges would silently lose one, and the loss would look like the bug this batch is
       fixing. #4 made exactly this change to the network walk for a crossover, and the cost is one string
       concatenation.

       WHAT IS ASSERTED IS WHAT CAN BE: that the board really does offer two arms at Altoona, so the
       distinction is about something real rather than about a hex that has one way through. The `crossingAt`
       half of the fix IS observable and has its own case above -- deleting it fails "marks the crossing as a
       bypass". */
    const { traversalsFrom } = require("./trackSegments") as typeof import("./trackSegments");
    const arms = traversalsFrom(BARE, H12.q, H12.r, 0);
    expect(arms.length).toBe(2);
    expect(arms.filter((arm) => arm.bypass === true).length).toBe(1);
    // Both arms leave by the same edge, which is why the key cannot be observed on this board.
    expect(new Set(arms.map((arm) => arm.exitEdge)).size).toBe(1);
  });

  it("behaves exactly as before when no blocker is supplied", () => {
    /* THE COMPATIBILITY PROPERTY, which is what makes this change additive: every pre-#1023 caller passes no
       predicate and must get the path it always got. */
    const withoutBlocker = bridgeWaypoints(BARE, point(H14), point(H10));
    expect(withoutBlocker?.map((hex) => hex.hexLabel)).toContain("H12");
  });
});

describe("the draft editor bridges it too", () => {
  it("accepts a click across Altoona", () => {
    /* THE PLAYER'S ACTUAL GESTURE: a draft standing on H14, a click on H10. The report says this refused --
       "no matter which adjacent hexes the player clicks to force it" -- because the bridge underneath it had
       never been told a city could be shut. */
    const edit = editRouteDraft({
      mapGrid: BARE,
      points: [point(H14)],
      click: point(H10),
      displayLabel: "H10",
      maxDistance: null,
      blocksThrough,
    });
    expect(edit.ok).toBe(true);
  });

  it("puts the bow into the draft it commits", () => {
    const edit = editRouteDraft({
      mapGrid: BARE,
      points: [point(H14)],
      click: point(H10),
      displayLabel: "H10",
      maxDistance: null,
      blocksThrough,
    });
    if (!edit.ok) throw new Error(edit.reason);
    expect(edit.points.map((entry) => entry.hexLabel)).toContain("H12");
  });
});

describe("item 3: the crossing survives the submit-path validator", () => {
  /* THE WHOLE POINT OF THE REPORT -- "route through an Altoona tile that contains a blocking token without
     triggering a validation error". The router and the validator were disagreeing, so the claim is only worth
     anything if both are asked about the SAME path. */
  const drafted = () => {
    const edit = editRouteDraft({
      mapGrid: BARE,
      points: [point(H14)],
      click: point(H10),
      displayLabel: "H10",
      maxDistance: null,
      blocksThrough,
    });
    if (!edit.ok) throw new Error(edit.reason);
    return edit.points;
  };

  it("raises no token-block refusal", () => {
    const reason = routeBlockedCityReason(
      drafted(),
      blocksThrough,
      (q, r) => STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? null,
      (q, r) => hexOffersBypass(BARE, q, r),
      (hex, from) => cityEnteredFrom(BARE, hex, from),
    );
    expect(reason).toBeNull();
  });

  it("is still marked as a bypass after the dispatch pass", () => {
    /* `withForcedBypass` runs on the way to the wire and re-derives the flag. It must agree with the bridge
       rather than overwrite it -- two derivations of one fact is the shape this codebase keeps finding, so
       the agreement is asserted rather than assumed. */
    const marked = withForcedBypass(drafted(), BARE, blocksThrough);
    const altoona = marked.find((entry) => entry.hexLabel === "H12") as
      | { bypass?: boolean }
      | undefined;
    expect(altoona?.bypass).toBe(true);
  });

  it("still refuses a genuinely walled hex that has no bow", () => {
    /* THE REGRESSION THIS FIX COULD MOST EASILY HAVE CAUSED. Altoona is passable because it has a bow, not
       because it is tokened -- a hex with a shut city and no way round must still be a wall, or #729's whole
       rule has been deleted in the course of exempting one tile. */
    const walled = cityBlockerFor({
      actingCompanyId: CO,
      companies: [{ company_id: PRR, station_token_hexes: [[H14.q, H14.r]] }],
      slotsAt: (q, r, city) => (q === H14.q && r === H14.r && city === 0 ? 1 : 0),
      cityOf: () => 0,
    });
    const straightThroughH14 = [point(H10), point(H12), point(H14), { q: H14.q + 1, r: H14.r, hexLabel: "H16" }];
    const reason = routeBlockedCityReason(
      straightThroughH14,
      walled,
      (q, r) => STATIC_BOARD_HEXES.find((hex) => hex.q === q && hex.r === r)?.label ?? null,
      (q, r) => hexOffersBypass(BARE, q, r),
      (hex, from) => cityEnteredFrom(BARE, hex, from),
    );
    expect(reason).toMatch(/tokened out/);
  });
});

describe("the shell actually asks", () => {
  /* ==================================================================
      A CONTROL PASSED WITHOUT THIS, WHICH IS #1006's LESSON AGAIN
     ==================================================================
     Deleting the shell's `blocksThrough:` argument left every case in this file green -- because every case
     calls `editRouteDraft` directly and supplies its own predicate. A helper that takes the right argument and
     a caller that never passes one is precisely the bug two batches ago, and the harness would not have seen
     it. The behaviour is proved above; this is the wiring. */
  it("hands the draft editor the same wall the other walks use", () => {
    /* ==================================================================
       BOUNDED, BECAUSE THE UNBOUNDED VERSION ALSO PASSED THE CONTROL
       ==================================================================
       The first draft searched the whole file for `blocksThrough: blocksThroughCityRef.current,` -- which
       appears FOUR times, once per walk that takes the predicate. Deleting the editor's copy left the other
       three, so the assertion was satisfied by call sites it was not about. A count would have been brittle;
       a SLICE names the caller.
       This is #886's bounded-slice rule reached from the other direction: not a slice that turned out empty,
       but a search whose haystack was larger than its subject. */
    const editorCall = sliceBetween(
      readStripped("App.tsx"),
      "const edit = editRouteDraft({",
      "});",
    );
    expect(editorCall).toContain("blocksThrough: blocksThroughCityRef.current,");
  });

  it("hands the bridge its predicate through the editor", () => {
    /* The editor is the only caller that can reach the bridge from a click, so the argument has to survive
       both hops -- asserted separately because a fix at either end alone would leave the loop closed. */
    expect(readStripped("utils/routeDraftEdit.ts")).toContain("blocksThrough,");
  });
});
