// frontend/src/utils/sandboxHomeHex.test.ts
//
// ===================================================================
//  DESIGN NOTE 607: THE TEST THAT WOULD HAVE CAUGHT C&O
// ===================================================================
//
// REPORTED: C&O's preprinted home station sits on Cleveland (F6), but
// floating it opened the "Place Home Station" prompt on Richmond (K15) and
// placed the token there -- and the corporation card then agreed with the
// prompt, because both read the same wrong source.
//
// The cause was two hand-maintained tables of one fact. `STATION_HOME_HEXES`
// mirrors the contract's `hexmap::CORPORATION_HOME_HEX` and is what the board
// draws its reservation markers from; `SANDBOX_CORPORATIONS` typed its own
// copy, and one of its eight entries was wrong.
//
// WHY A TEST AND NOT JUST THE FIX. Design note #607 in `sandboxState.ts`
// derives the fixture from the constant, which makes the drift impossible
// today. This pins that it STAYS impossible: `homeHexFor` is a private
// helper and nothing stops a future edit from typing a literal back in for
// one corporation, which is exactly the shape of the original bug and
// exactly as invisible.
//
// THE AUDIT IS THE ASSERTION. The request asked for all eight placements to
// be checked, and a test is the only form of that answer with a shelf life --
// a reply saying "I checked, the other seven are fine" is true on the day it
// is written and unverifiable a month later.

import { STATION_HOME_HEXES } from "../components/hexContractTypes";
import { SANDBOX_CORPORATIONS } from "./sandboxState";

describe("the sandbox fixture agrees with the board's preprinted home hexes", () => {
  it("gives every corporation the hex its reservation marker is printed on", () => {
    for (const home of STATION_HOME_HEXES) {
      const fixture = SANDBOX_CORPORATIONS.find((entry) => entry.id === home.companyId);
      expect(fixture).toBeDefined();
      expect({ id: home.companyId, homeHex: fixture?.homeHex }).toEqual({
        id: home.companyId,
        homeHex: home.label,
      });
    }
  });

  it("covers all eight core corporations in both tables", () => {
    // Design note #44's house rule seats NNH on G19, so eight is eight in
    // both directions -- a table that quietly lost an entry would otherwise
    // pass the loop above by simply not iterating over it.
    expect(STATION_HOME_HEXES).toHaveLength(8);
    expect(SANDBOX_CORPORATIONS).toHaveLength(8);
    expect(new Set(STATION_HOME_HEXES.map((home) => home.label)).size).toBe(8);
  });

  it("puts C&O on Cleveland, not Richmond", () => {
    /* The reported bug, pinned by name. K15 is a dead-end stub on the far
       side of the map and is nobody's home; a regression here would send the
       Place Home Station prompt back across the board. */
    const co = SANDBOX_CORPORATIONS.find((entry) => entry.ticker === "C&O");
    expect(co?.homeHex).toBe("F6");
    expect(co?.homeHex).not.toBe("K15");
  });
});
