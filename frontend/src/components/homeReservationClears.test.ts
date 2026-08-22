/** @jest-environment node */
//
// One predicate and a source scan; no React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 724 (harness): THE BADGE OUTLIVED THE TOKEN
// ==================================================================
//
// REPORTED: "when I upgraded Baltimore (B&O's home station hex), the green tile has a 'ghost' B&O marker on it
// -- I am guessing that is the home station reservation marker, based on its position. The home station
// reservation markers need to be hidden after the home station is placed."
//
// THE GUESS WAS RIGHT AND THE CAUSE IS ONE FIELD. `homePlaced` asked `station_tokens` -- the OPTIONAL
// `(q, r, city_index)` mirror -- when the required list is `station_token_hexes`. `hexContractTypes` states the
// consequence in its own doc comment: an empty `station_tokens` means "this chain doesn't know", never "no
// tokens". Read as "no tokens", the reservation badge is drawn for the rest of the game.
//
// WHY IT SURVIVED A WHOLE PHASE -- corrected, because the first draft of this paragraph invented a reason.
// It said the green tile gives I15 a second station slot. REPORTED back: "I15's green tile does NOT give it a
// second station slot. It simply moves the city/station from its off-center position on the preprinted yellow
// tile to a centered position."
//
// The real mechanism is better and implicates a SECOND defect. The badge called `stationMarkerPoint` with no
// laid tile, taking its tile-less fallback; preprinted track is not a `tiles` entry, so on yellow I15 the real
// token pass had no tile either and both landed on the same point. One marker, correct-looking. Laying green
// creates a real entry, the token moves to the tile's own city anchor -- the recentring the report describes --
// and the badge stays behind. Hence #724a, which hands the badge the laid tile too.
//
// THE LESSON IS THE ONE THIS CODEBASE KEEPS RELEARNING, this time in a note I wrote: an explanation that fits
// the symptom is not thereby true. Nothing in the fix depended on the slot claim, which is exactly what made
// it easy to state without checking.
//
// SO THE CASES BELOW ARE ALL ABOUT THE OPTIONAL FIELD BEING ABSENT. A fixture that populates `station_tokens`
// passes against the broken code, which is precisely why the bug reached a playthrough.

import { YELLOW_OO_HEXES } from "./hexBoardData";
import {
  STATION_HOME_HEXES,
  hasStationTokenAt,
  tokenCityIndex,
  type StationTokenCompany,
} from "./hexContractTypes";

/** Baltimore -- B&O's home hex. */
const I15: readonly [number, number] = [3, 8];
const ELSEWHERE: readonly [number, number] = [9, 4];

function bo(over: Partial<StationTokenCompany> = {}): StationTokenCompany {
  return {
    company_id: 2,
    ticker: "B&O",
    is_floated: true,
    station_token_hexes: [],
    ...over,
  } as unknown as StationTokenCompany;
}

describe("a placed home token clears its reservation", () => {
  it("reports the token when the chain omits city indices", () => {
    /* THE REPORT, AS A UNIT. `station_tokens` absent is the ordinary case for a chain predating Audit G-12,
       and it is the one the old predicate got backwards. */
    const placed = bo({ station_token_hexes: [[...I15] as [number, number]] });
    expect(placed.station_tokens).toBeUndefined();
    expect(hasStationTokenAt(placed, I15[0], I15[1])).toBe(true);
  });

  it("reports the token when the chain sends an EMPTY city list", () => {
    /* The nastier half: `[]` is a value, so `?.some()` returns `false` rather than `undefined` and no `??`
       fallback rescues it. The type comment calls this out -- empty means "doesn't know" -- and reading it as
       "none" is the whole bug. */
    const placed = bo({
      station_token_hexes: [[...I15] as [number, number]],
      station_tokens: [],
    });
    expect(hasStationTokenAt(placed, I15[0], I15[1])).toBe(true);
  });

  it("still reports nothing before the home token is placed", () => {
    /* #608'S CASE, which must survive: between floating and placing there is no token, and the badge is the
       only thing marking the hex the Place Home Station prompt is about. A fix that always returned `true`
       would blank exactly that hex. */
    expect(hasStationTokenAt(bo(), I15[0], I15[1])).toBe(false);
  });

  it("does not confuse a token somewhere else for this hex", () => {
    const away = bo({ station_token_hexes: [[...ELSEWHERE] as [number, number]] });
    expect(hasStationTokenAt(away, I15[0], I15[1])).toBe(false);
  });

  it("agrees with the chain when it DOES know the city", () => {
    // The two questions must not diverge on a chain that answers both.
    const placed = bo({
      station_token_hexes: [[...I15] as [number, number]],
      station_tokens: [[I15[0], I15[1], 1]],
    });
    expect(hasStationTokenAt(placed, I15[0], I15[1])).toBe(true);
    expect(tokenCityIndex(placed, I15[0], I15[1])).toBe(1);
  });
});

describe("the two questions stay distinguishable", () => {
  it("keeps 'which city' able to answer 'I do not know'", () => {
    /* #134's rule, unchanged by #724 and worth guarding: `undefined` is a DIFFERENT answer from `0`, because
       the caller falls back to a heuristic rather than asserting city zero and drawing a token in the wrong
       station. Collapsing the two questions into one field would have destroyed this. */
    const placed = bo({ station_token_hexes: [[...I15] as [number, number]] });
    expect(tokenCityIndex(placed, I15[0], I15[1])).toBeUndefined();
    expect(hasStationTokenAt(placed, I15[0], I15[1])).toBe(true);
  });
});

describe("Baltimore is a real home hex, so the fixture is not fiction", () => {
  it("is B&O's home in the board table", () => {
    /* The coordinates above are asserted against the shipped table rather than trusted -- a harness proving a
       rule about a hex that does not exist is the failure mode of every fixture written from memory. */
    const home = STATION_HOME_HEXES.find((entry) => entry.label === "I15");
    expect(home).toBeDefined();
    expect([home!.q, home!.r]).toEqual([...I15]);
  });
});

describe("every home hex, not just the one that was reported", () => {
  /* ==================================================================
   *  DESIGN NOTE 724b: THE FIX WAS BOARD-WIDE; THE TEST WAS NOT
   * ==================================================================
   *
   * REPORTED: "The 'ghost' home station reservation marker that we saw on I15 also occurs on Boston's hex E23.
   * In both cases the preprinted yellow B tile has an off-center city that becomes centered on the green tile.
   * This may have been corrected in earlier step."
   *
   * IT WAS, AND THE GUESS DESERVED A PROOF RATHER THAN AGREEMENT. #724 changed which FIELD decides whether a
   * home token exists, and #724a changed how the badge is anchored -- both in the shared drawing pass, so
   * neither could ever have been specific to Baltimore. But this file only exercised I15, so "it is fixed
   * everywhere" was a claim about code nobody had run against E23.
   *
   * SO THE SWEEP REPLACES THE ASSURANCE. Every home hex on the board, not the two that have been noticed.
   *
   * AND ONE THING GENUINELY DID NEED CHECKING. #724a hands the badge the laid tile so it follows the tile's
   * city anchor -- but only on the ORDINARY branch. The four `YELLOW_OO_HEXES` take #43's hex-margin branch
   * instead, which deliberately ignores the tile, because a President may still choose either of the two
   * slots and committing the badge to one would lie about that. E23 is NOT one of them, so it inherits the
   * fix; had it been, the report would have found a second bug rather than an instance of a fixed one. That
   * distinction is asserted below rather than left to a reader to rediscover. */

  it("covers the whole roster", () => {
    // A sweep over a truncated table would pass silently.
    expect(STATION_HOME_HEXES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(STATION_HOME_HEXES.map((home) => [home.label, home.q, home.r] as const))(
    "clears %s's reservation once its token is placed",
    (_label, q, r) => {
      const placed = bo({ station_token_hexes: [[q, r] as [number, number]] });
      expect(hasStationTokenAt(placed, q, r)).toBe(true);
    },
  );

  it.each(STATION_HOME_HEXES.map((home) => [home.label, home.q, home.r] as const))(
    "still marks %s before placement",
    (_label, q, r) => {
      // #608: between floating and placing, the badge is the only thing naming the hex the prompt is about.
      expect(hasStationTokenAt(bo(), q, r)).toBe(false);
    },
  );

  it("names Boston, which the report asked about", () => {
    /* The fixture's premise, read back: E23 is a home hex and it is NOT an OO hex, so it takes the branch
       #724a fixed. Both halves matter -- the second is why the answer is "already fixed" rather than "a second
       bug". */
    const boston = STATION_HOME_HEXES.find((home) => home.label === "E23");
    expect(boston).toBeDefined();
    expect(YELLOW_OO_HEXES.has("E23")).toBe(false);
  });

  it("leaves the OO hexes on their own anchor, deliberately", () => {
    /* #43's rule, unchanged by #724a and worth guarding: an unfloated OO badge sits in neutral margin space
       because either slot is still available. A later reader "finishing" #724a by handing those branches the
       laid tile too would commit the badge to a slot the President has not chosen. */
    const bar = (() => {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      return fs.readFileSync(path.join(__dirname, "HexGridRenderer.tsx"), "utf8");
    })();
    expect(bar).toContain("YELLOW_OO_HEXES.has(home.label)");
    expect(bar).toContain("stationMarkerPoint(home.q, home.r, hexSize, homeLaidTile)");
  });
});

describe("no surface asks the optional list whether a token exists", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, rel), "utf8");
    // Comments discuss the wrong field by name, in the past tense, and must keep doing so -- #490a.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("has no presence test left on station_tokens", () => {
    /* THE STRUCTURAL HALF, and the one that would actually have caught this: the predicate above can be
       perfect while a fourth call site asks the wrong field, which is exactly the state the codebase was in.
       Three copies agreed and the renderer's did not. */
    for (const file of ["HexGridRenderer.tsx", "hexGeometry.ts"]) {
      expect(read(file)).not.toMatch(/station_tokens\s*\??\.\s*some/);
    }
  });

  it("routes the renderer's home check through the named predicate", () => {
    expect(read("HexGridRenderer.tsx")).toContain(
      "hasStationTokenAt(company, home.q, home.r)",
    );
  });

  it("anchors the reservation badge on the laid tile, like the token", () => {
    /* Design note #724a. The badge took `stationMarkerPoint`'s tile-less fallback while the real token used
       the tile's city anchor, so the two agreed only while the hex was bare -- which is what made #724's
       stale badge look like one correct marker until an upgrade moved the city under it.
       Asserted as source because a canvas point has no DOM to query, the same instrument
       `privatePowerBadge.test.ts` uses and for the same reason. */
    const code = read("HexGridRenderer.tsx");
    expect(code).toContain("stationMarkerPoint(home.q, home.r, hexSize, homeLaidTile)");
    expect(code).not.toContain("stationMarkerPoint(home.q, home.r, hexSize)");
  });

  it("leaves tokenCityIndex reading the optional list, which is its job", () => {
    expect(read("hexContractTypes.ts")).toContain("company.station_tokens?.find");
  });
});
