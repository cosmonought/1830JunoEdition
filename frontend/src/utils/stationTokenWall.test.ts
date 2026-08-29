/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1006 (harness): THE FOURTH CALLER
// ==================================================================
//
// REPORTED: "C&O was able to place a station marker on hexes J14 and K15 by tracing a route through the
// Baltimore hex. However, Baltimore was completely tokened out by B&O."
//
// THE WALK WAS RIGHT AND NOBODY ASKED IT. `reachableTrack` has taken a `blocksThrough` predicate since #729,
// `cityBlocking.ts` states the three rules, and `routeCityBlocking.test.ts` proves the route tracer honours
// them. What none of that covered is that the predicate is an OPTIONAL third argument -- so a caller that
// does not pass it gets the pre-#729 board, silently, with no type error and no failing test. The station
// placement gate was that caller.
//
// WHY THE HARNESS DID NOT CATCH IT EITHER, which is the part worth keeping. #729 and #730 both tested the
// WALK: give `reachableTrack` a blocker, watch it stop. Both passed, and both would still pass with the gate
// wired to nothing, because neither went through `evaluateStationPlacement`. A rule tested at the module that
// implements it and never at the module that has to remember to ask is a rule with a door beside it -- #712's
// sentence, and this is the third time it has been the answer.
//
// SO EVERY CASE HERE ENTERS THROUGH THE GATE, not through the walk. `evaluateStationPlacement` and
// `placeableStationHexes` are what the click and the veil call, so they are what gets asked.
//
// AND THE BOARD IS THE REAL ONE. Baltimore is preprinted -- it holds a token before anybody lays anything --
// which is exactly the case #729's note flags as the one a slot resolver reading only `tiles` reports as zero,
// and zero slots reads as "not a city", which opens the wall. A synthetic city would prove the mechanism and
// miss the reason it was Baltimore in the report.

import { LANDMARK_TRACKS, STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import {
  citySlotCount,
  evaluateStationPlacement,
  placeableStationHexes,
  stationSlotCount,
  type StationPlacementCompany,
} from "./stationTokens";
import { hexKey } from "./trackReach";
import type { MapGridResponse } from "../components/hexContractTypes";

/** The reported hexes, FOUND rather than typed -- #686's rule: a coordinate written by hand is one board edit
 *  away from testing empty space. */
const BALTIMORE = STATIC_BOARD_HEXES.find((hex) => hex.label === "I15")!;
const J14 = STATIC_BOARD_HEXES.find((hex) => hex.label === "J14")!;
const K15 = STATIC_BOARD_HEXES.find((hex) => hex.label === "K15")!;
const I17 = STATIC_BOARD_HEXES.find((hex) => hex.label === "I17")!;
const H16 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H16")!;

/* THE CORRIDOR, laid one hex at a time so the only route from the placing corporation's token to the reported
   hexes runs THROUGH Baltimore. If a second path existed the test would pass for the wrong reason.
     H16 -- tile 57 orientation 2, edges {2,5}: a yellow city holding the placing corporation's token.
     I17 -- tile  7 orientation 2, edges {2,3}: bare track joining H16 to Baltimore.
     I15 -- BALTIMORE, preprinted, no tile laid. `LANDMARK_TRACKS` gives it edges {0,4} and the walk reports
            e0 <-> e4, so it is a straight corridor with a single station circle in the middle of it.
     J14 -- tile 14 orientation 1, edges {1,2,4,5}: a two-slot city facing Baltimore (1) and K15 (5).
     K15 -- tile 57 orientation 2, edges {2,5}: the far end, facing J14. */
const CORRIDOR_TILES = [
  { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
  { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
  { q: J14.q, r: J14.r, tile_id: 14, orientation: 1 },
  { q: K15.q, r: K15.r, tile_id: 57, orientation: 2 },
];

const BOARD = { game_id: 1, tiles: CORRIDOR_TILES } as unknown as MapGridResponse;

/** The same corridor with a FOUR-SPOKE, TWO-SLOT city laid on Baltimore -- tile 15 orientation 3, whose edges
 *  are {0,3,4,5} and which still joins e0 to e4. Rules 1 and 2 need a city with room in it, and rewriting
 *  Baltimore is preferable to moving the test to a hex nobody reported. */
const BOARD_BIG_BALTIMORE = {
  game_id: 1,
  tiles: [...CORRIDOR_TILES, { q: BALTIMORE.q, r: BALTIMORE.r, tile_id: 15, orientation: 3 }],
} as unknown as MapGridResponse;

function corporation(
  companyId: number,
  hexes: ReadonlyArray<readonly [number, number]>,
): StationPlacementCompany {
  return {
    company_id: companyId,
    is_floated: true,
    station_token_hexes: hexes,
    station_token_limit: 4,
  };
}

/** C&O and B&O by their real ids, from the table the game uses. */
const CO_ID = STATION_HOME_HEXES.find((home) => home.label === "F6")!.companyId;
const BO_ID = STATION_HOME_HEXES.find((home) => home.label === "I15")!.companyId;
const NYC_ID = STATION_HOME_HEXES.find((home) => home.label === "E19")!.companyId;

/** The placing corporation: one token, on the far side of Baltimore from the reported hexes. */
const CO = corporation(CO_ID, [[H16.q, H16.r]]);
/** The wall. */
const BO_IN_BALTIMORE = corporation(BO_ID, [[BALTIMORE.q, BALTIMORE.r]]);

function place(
  mapGrid: MapGridResponse,
  hex: { q: number; r: number },
  allCompanies: readonly StationPlacementCompany[],
  company: StationPlacementCompany = CO,
) {
  return evaluateStationPlacement({
    mapGrid,
    q: hex.q,
    r: hex.r,
    company,
    allCompanies,
    cityIndex: 0,
  });
}

const NOT_REACHED = /track does not reach this city/;

describe("the board really does put a single station in the way", () => {
  /* THE FIXTURE'S OWN ASSUMPTIONS, asserted before anything is built on them. Every case below is vacuous if
     Baltimore turns out to have two slots, or if the corridor does not actually run through it -- and a
     vacuous pass is the failure mode this batch exists because of. */
  it("Baltimore is a preprinted one-slot city", () => {
    /* THE NUMBER THAT DECIDES EVERYTHING. #729's rule 3 reads zero slots as "not a city, cannot be full", so a
       resolver blind to preprinted cities would report 0 here and open the wall without any of the blocking
       code being wrong. This is the assertion that would have failed first if `citySlotCount` had been written
       to read `tiles` alone. */
    expect(citySlotCount(BOARD, BALTIMORE.q, BALTIMORE.r, 0)).toBe(1);
    expect(stationSlotCount(BOARD, BALTIMORE.q, BALTIMORE.r)).toBe(1);
    expect(BOARD.tiles.some((tile) => tile.q === BALTIMORE.q && tile.r === BALTIMORE.r)).toBe(false);
  });

  it("the reported hexes lie on the far side of it", () => {
    /* Baltimore's printed track is a straight, so the corridor has no way round. Read from `LANDMARK_TRACKS`
       rather than restated, so a board edit breaks this rather than silently making the walls irrelevant. */
    expect(LANDMARK_TRACKS.Baltimore).toEqual([{ edges: [0, 4] }]);
    const offsets = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    const across = (edge: number) => ({
      q: BALTIMORE.q + offsets[edge][0],
      r: BALTIMORE.r + offsets[edge][1],
    });
    expect(across(0)).toEqual({ q: I17.q, r: I17.r });
    expect(across(4)).toEqual({ q: J14.q, r: J14.r });
  });

  it("without the wall the corporation genuinely reaches both of them", () => {
    /* THE CONTROL THAT MAKES EVERY REFUSAL BELOW MEAN SOMETHING. A corridor that did not connect would refuse
       J14 for want of track, and the test would report the wall working while the wall did nothing. */
    expect(place(BOARD, J14, [CO]).allowed).toBe(true);
    expect(place(BOARD, K15, [CO]).allowed).toBe(true);
  });
});

describe("a tokened-out city blocks a station placement beyond it", () => {
  it("refuses the reported hex", () => {
    // The report, as nearly verbatim as a fixture gets: C&O, J14, Baltimore full of B&O.
    const result = place(BOARD, J14, [CO, BO_IN_BALTIMORE]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(NOT_REACHED);
  });

  it("refuses the hex beyond that one too", () => {
    /* K15 IS NOT A SECOND MECHANISM -- it is the same wall one hex further on, and it is asserted because the
       report named it. A fix that halted the walk one step late would let this through while J14 refused. */
    const result = place(BOARD, K15, [CO, BO_IN_BALTIMORE]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(NOT_REACHED);
  });

  it("blocks the hex-level question as well as the circle-level one", () => {
    /* TWO ARMS, ONE RULE. #893 split the connectivity check: a caller that names a circle asks
       `reachableCities`, one that cannot asks `reachableNetwork`. The veil is the second kind, so wiring only
       the arm the click uses would leave the board lighting J14 while the click refused it -- #891's shape
       reintroduced by the fix for #891's shape. `cityIndex` omitted takes the other arm. */
    const result = evaluateStationPlacement({
      mapGrid: BOARD,
      q: J14.q,
      r: J14.r,
      company: CO,
      allCompanies: [CO, BO_IN_BALTIMORE],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(NOT_REACHED);
  });

  it("takes the hex out of the veil's highlighted set", () => {
    /* THE SURFACE THE PLAYER ACTUALLY SEES. `placeableStationHexes` is what lights the board during the Tokens
       step, and it inherits the rule through `evaluateStationPlacement` rather than by its own edit -- which
       is the point of building the blocker inside the gate instead of accepting one per call site. */
    const boardHexes = STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const);
    const open = placeableStationHexes({
      mapGrid: BOARD,
      company: CO,
      allCompanies: [CO],
      boardHexes,
    });
    const walled = placeableStationHexes({
      mapGrid: BOARD,
      company: CO,
      allCompanies: [CO, BO_IN_BALTIMORE],
      boardHexes,
    });
    expect(open.has(hexKey(J14.q, J14.r))).toBe(true);
    expect(walled.has(hexKey(J14.q, J14.r))).toBe(false);
    expect(walled.has(hexKey(K15.q, K15.r))).toBe(false);
  });
});

describe("blocked is not unreachable", () => {
  it("refuses Baltimore itself for being FULL, not for being unreached", () => {
    /* #729's "REACHED, BUT NOT PASSED", enforced at the gate. The blocked city stays in the walk's `cities`
       set, so this arm never fires for it -- and the player is told the true reason, which is that the slot is
       taken. A fix that dropped the blocked city from the walk would pass "cannot place beyond it" and swap
       this sentence for the wrong one, which is a worse bug than the one being fixed: it tells a president
       their track does not reach a city their trains run to. */
    const result = place(BOARD, BALTIMORE, [CO, BO_IN_BALTIMORE]);
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toMatch(NOT_REACHED);
    expect(result.reason).toMatch(/only station slot is taken/);
  });
});

describe("the three rules of the wall, asked through the gate", () => {
  it("rule 1: room is room -- one rival token in a two-slot city does not block", () => {
    /* `others >= slots`, NOT `others >= 1`. The reported bug is an under-block, so the obvious over-correction
       -- any rival token walls the city -- would fix the report and silently delete legal placements all over
       a busy board, where they would be invisible rather than merely wrong. */
    expect(citySlotCount(BOARD_BIG_BALTIMORE, BALTIMORE.q, BALTIMORE.r, 0)).toBe(2);
    expect(place(BOARD_BIG_BALTIMORE, J14, [CO, BO_IN_BALTIMORE]).allowed).toBe(true);
  });

  it("rule 1: and a second rival closes it", () => {
    // The discriminating half: same board, same city, one more foreign token.
    const nyc = corporation(NYC_ID, [[BALTIMORE.q, BALTIMORE.r]]);
    const result = place(BOARD_BIG_BALTIMORE, J14, [CO, BO_IN_BALTIMORE, nyc]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(NOT_REACHED);
  });

  it("rule 2: a corporation is never walled by a city it occupies", () => {
    /* ==================================================================
       WHAT THIS ACTUALLY PROVES, AND A CONTROL THAT CAUGHT ME CLAIMING MORE
       ==================================================================
       The first version of this case asserted the same thing and said it was testing that the blocker is
       bound to `company.company_id`. Mutating `actingCompanyId` to `null` -- deleting rule 2 outright -- left
       it GREEN, so the claim was false.

       THE REASON IS #729's OTHER EXEMPTION, one paragraph above rule 2 in that note: "NEVER FROM A STATION".
       The walk seeds from every hex this corporation holds a token on, and a start has no arrival edge, so the
       blocker is never consulted there at all. A corporation that owns a slot in a full city is therefore
       already exempt by CONSTRUCTION before rule 2 is reached.

       WHICH MAKES `actingCompanyId` UNOBSERVABLE THROUGH THIS GATE, and that is worth stating rather than
       hiding behind a test that cannot see it: a corporation is walled by a city only when it has no token
       there, and when it does have one, that city is a start. There is no board on which the two disagree
       here. It is still passed, and correctly: `cityBlockerFor` is shared with the tile-lay walk and the route
       tracer (#730), where a start is not always the corporation's own city and the binding decides real
       cases. One shape across four callers is worth more than an argument omitted because this caller cannot
       tell the difference.

       SO THIS IS A CONTROL, NOT A PROOF OF THE WALL. It fails if a future fix consults the blocker on starts
       -- which would wall every corporation out of its own full home city, on a busy board, invisibly. */
    const coInBaltimore = corporation(CO_ID, [
      [H16.q, H16.r],
      [BALTIMORE.q, BALTIMORE.r],
    ]);
    expect(citySlotCount(BOARD_BIG_BALTIMORE, BALTIMORE.q, BALTIMORE.r, 0)).toBe(2);
    // Full -- both slots taken -- and one of them is this corporation's.
    const result = place(
      BOARD_BIG_BALTIMORE,
      J14,
      [coInBaltimore, BO_IN_BALTIMORE],
      coInBaltimore,
    );
    expect(result.allowed).toBe(true);
  });

  it("rule 2: and the exemption survives a city the corporation does NOT hold", () => {
    /* THE DISCRIMINATING HALF THE CASE ABOVE LACKS. Same board, same two-slot Baltimore, both slots foreign --
       so the start exemption has nothing to grant and the wall is the only thing deciding. Without it this
       reads identically to the case above and the pair would prove nothing together. */
    const nyc = corporation(NYC_ID, [[BALTIMORE.q, BALTIMORE.r]]);
    const result = place(BOARD_BIG_BALTIMORE, J14, [CO, BO_IN_BALTIMORE, nyc]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(NOT_REACHED);
  });

  it("rule 3: a hex with no station circles can never be full of anything", () => {
    /* TOWNS DO NOT BLOCK, and "zero slots" is one sign away from "a city with no room" in the obvious
       implementation. I17 carries bare track (tile 7, no markers), so a token recorded there is not a board
       state the game can produce -- which is exactly why it is worth asserting: the rule has to hold on
       malformed input, because the alternative is a wall across a corridor with nothing visible in it. */
    expect(citySlotCount(BOARD, I17.q, I17.r, 0)).toBe(0);
    const ghost = corporation(NYC_ID, [[I17.q, I17.r]]);
    expect(place(BOARD, J14, [CO, ghost]).allowed).toBe(true);
  });
});
