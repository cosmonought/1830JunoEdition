/** @jest-environment node */
//
// The D&H's free station keeps the Tokens step open. No React.
//
// ==================================================================
//  DESIGN NOTE 781 (harness): THE STEP SKIPPED ITSELF PAST A REAL MOVE
// ==================================================================
//
// REPORTED as two bugs and it is one:
//   "as soon as the track was laid the subphase autoskipped to Run Routes (skipping the Station Token step)"
//   "on the turn after using its special Lay Track power, the Place Station special power suddenly became
//    available. I believe these are supposed to be done on the same turn, not split."
//
// THE SECOND IS THE FIRST, SEEN FROM THE OTHER END. The power was never unavailable; the STEP that hosts it
// was being skipped, so the player could not reach the control until the next turn happened to leave the step
// standing.
//
// AND THE CAUSE IS #776'S, ONE COMPONENT OVER. Every arm of `stationPlacementBlockReason` describes an
// ORDINARY placement -- paid for, on a city the network reaches. The D&H's token is free and ignores
// connectivity, so the predicate honestly reported "its network reaches no city with a free station slot"
// about a corporation that had a perfectly legal placement waiting.
//
// THE ARM THAT MUST SURVIVE is the token limit. A corporation has a finite pile of markers and no private
// power adds to it, so an exemption that skipped that check would let the D&H conjure a token. Pinned below,
// because it is the one that would be easiest to lose while making the other two give way.

import { stationPlacementBlockReason } from "./stationTokens";
import { dhPowerState } from "./dhPower";
import type { MapGridResponse } from "../components/hexContractTypes";

const EMPTY_GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

const company = (over: Record<string, unknown> = {}) =>
  ({
    company_id: 3,
    ticker: "NYNH",
    treasury: "500",
    station_token_hexes: [[0, 0]],
    station_token_limit: 4,
    ...over,
  }) as never;

const ask = (over: Record<string, unknown> = {}, extraTokenAvailable = false) =>
  stationPlacementBlockReason({
    mapGrid: EMPTY_GRID,
    company: company(over),
    allCompanies: [company(over)],
    boardHexes: [
      [0, 0],
      [1, 0],
    ],
    extraTokenAvailable,
  });

describe("an ordinary placement is judged exactly as before", () => {
  it("reports an unreachable network", () => {
    /* THE CONTROL, and the one the whole auto-skip depends on: with no D&H token available this must still
       report the block, or a corporation with genuinely nowhere to place is stranded on a dead step. */
    expect(ask()).toBe("its network reaches no city with a free station slot");
  });

  it("reports an empty treasury", () => {
    /* One token already down, so the NEXT one is charged for -- the first draft emptied the pile as well and
       got the network refusal instead, because a corporation with no tokens placed pays nothing for its
       home. The arm being tested is the one that only exists once a corporation is buying. */
    expect(ask({ treasury: "0" })).toMatch(/treasury holds \$0/);
  });

  it("reports a spent token pile", () => {
    expect(ask({ station_token_limit: 1 })).toMatch(/all 1 of its station tokens/);
  });
});

describe("the D&H's token is a placement the predicate can see", () => {
  it("holds the step open when the free station is available", () => {
    /* THE REPORT. Same board, same empty network -- the difference is that this corporation has a legal
       placement the ordinary rules cannot describe. */
    expect(ask({}, true)).toBeNull();
  });

  it("holds it open with an empty treasury", () => {
    // The token is free. A corporation with $0 can still take it.
    expect(ask({ treasury: "0" }, true)).toBeNull();
  });

  it("still refuses when the token pile is spent", () => {
    /* THE ARM THAT SURVIVES. The D&H does not add a marker to the corporation's supply, so this refusal has
       to outrank the exemption -- which is why the exemption sits AFTER it rather than at the top. */
    expect(ask({ station_token_limit: 1 }, true)).toMatch(/all 1 of its station tokens/);
  });

  it("says nothing about a corporation that is not there", () => {
    expect(
      stationPlacementBlockReason({
        mapGrid: EMPTY_GRID,
        company: null,
        allCompanies: [],
        boardHexes: [],
        extraTokenAvailable: true,
      }),
    ).toBeNull();
  });
});

describe("the two halves belong to one turn", () => {
  it("offers the token the moment the lay is taken", () => {
    /* `dhPowerState` was right all along: the token becomes available as soon as the lay is used, in the same
       turn. Nothing about the ORDER needed changing -- only the step's willingness to stay open long enough
       for a player to reach it. */
    const afterLay = dhPowerState({ hexBuilt: true, layUsed: true, tokenUsed: false });
    expect(afterLay.tokenAvailable).toBe(true);
    expect(afterLay.forfeited).toBe(false);
  });

  it("does not offer the token before the lay", () => {
    const before = dhPowerState({ hexBuilt: false, layUsed: false, tokenUsed: false });
    expect(before.tokenAvailable).toBe(false);
    expect(before.tokenBlockedReason).toMatch(/Lay the F16 tile first/);
  });

  it("offers nothing once a rival has built on the hex", () => {
    const lost = dhPowerState({ hexBuilt: true, layUsed: false, tokenUsed: false });
    expect(lost.forfeited).toBe(true);
    expect(lost.tokenAvailable).toBe(false);
  });
});

describe("the shell asks for the exemption, and only for the owner", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: the note quotes the predicate's own refusal text while explaining it.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("passes the D&H's token availability", () => {
    expect(APP).toContain("extraTokenAvailable:");
    expect(APP).toContain("dhPower.tokenAvailable");
  });

  it("scopes it to the corporation that owns the private", () => {
    /* `dhPowerState` knows whether the ABILITY is spent, not whose it is. Without this a rival's Tokens step
       would be held open by somebody else's private -- a dead step in the other direction. */
    expect(APP).toContain("=== actingProtocolId");
    expect(APP).toContain("owner_protocol_id");
  });

  it("keeps the memo's dependencies honest", () => {
    // A gate read from a stale closure is not a gate -- #762 and #766, twice each.
    const memo = APP.slice(
      APP.indexOf("const stationPlacementBlock"),
      APP.indexOf("const turnIdentity"),
    );
    expect(memo).toContain("dhPower");
    expect(memo).toContain("actingProtocolId");
  });
});
