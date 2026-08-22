/** @jest-environment node */
//
// Pure set arithmetic over a board fixture; no React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 716 (harness): THE GLOW PROMISED A TILE
// ==================================================================
//
// REPORTED: "on the yellow/green tiles the white border is everywhere and loses its signal ... I have just
// realized that all of the hexes may have a white border ... This has the effect that tiles with no upgrades
// still appear with the white border that would suggest there's a legal tile placement on them."
//
// The diagnosis was right and the mechanism was the other way round. Nothing draws a white perimeter on every
// hex -- the base strokes are dark and tier-coloured, and the default highlight ink is green. The white is
// `STATION_PLACEMENT_HIGHLIGHT_INK`, applied to `reach.hexes` alone, which really is meant to be "the legal
// placements".
//
// THE SET WAS THE LIE. `layableHexes` filtered its candidates through `evaluateHexForTileLaying`, which asks
// only about the GROUND: is this a hex, is it a red off-board, is it forbidden anywhere. It never asks whether
// a tile exists that could go there. So a green city with no brown upgrade printed glowed exactly like an
// empty hex your track exits toward.
//
// WHY IT SURVIVED: on an opening board the two sets are nearly identical -- almost every reachable hex really
// does have a tile available -- so the mark was honest for the first several turns and drifted as the network
// grew. "Finally seeing a larger network" is precisely when it would show.
//
// WHAT THIS FILE PINS is the shape of the filter rather than any particular board: that the callback is
// consulted, that it can only ever REMOVE hexes, and that the network and ports travel with the question --
// because a callback asked without them would answer a different question than the picker the click opens.

import { layableHexes, type LayableHexInput } from "./trackReach";
import type { MapGridResponse } from "../components/hexContractTypes";

/** A tiny board with one laid tile the corporation has a token on. The exact hexes do not matter; what is
 *  under test is what the filter does with whatever the walk found. */
function boardWith(tiles: { q: number; r: number; tile_id: number; orientation: number }[]) {
  return { tiles } as unknown as MapGridResponse;
}

function reach(over: Partial<LayableHexInput> = {}) {
  return layableHexes({
    mapGrid: boardWith([{ q: 6, r: 6, tile_id: 57, orientation: 0 }]),
    stationHexes: [[6, 6]],
    ...over,
  });
}

describe("the callback can only take hexes away", () => {
  it("changes nothing when every hex has a tile available", () => {
    /* THE COMPATIBILITY CASE. A callback that always says yes must leave the old answer exactly as it was,
       or #716 would have moved the glow rather than narrowed it. */
    const before = reach();
    const after = reach({ hasPlaceableTile: () => true });
    expect(Array.from(after.hexes).sort()).toEqual(Array.from(before.hexes).sort());
  });

  it("empties the glow when nothing can be laid anywhere", () => {
    // THE REPORT'S CASE, taken to its limit: a board where no tile fits should glow nowhere at all.
    expect(reach({ hasPlaceableTile: () => false }).hexes.size).toBe(0);
  });

  it("keeps the NETWORK lit even when the glow empties", () => {
    /* #4's three tiers survive: "the network at full brightness, the extensions lit and glowed, everything
       else receding". Narrowing what GLOWS must not dim the track a player is reasoning about -- that was the
       first cut's mistake and it is still wrong. */
    const narrowed = reach({ hasPlaceableTile: () => false });
    expect(narrowed.network.size).toBeGreaterThan(0);
    expect(narrowed.networkSize).toBe(narrowed.network.size);
  });

  it("is a subset of what the ground alone allowed", () => {
    /* The property that makes this safe to add: the callback is an extra hurdle, never a new door. A hex the
       static board forbids cannot be glowed back into legality by a permissive callback. */
    const ground = reach();
    const asked = reach({ hasPlaceableTile: (q) => q % 2 === 0 });
    for (const key of Array.from(asked.hexes)) {
      expect(ground.hexes.has(key)).toBe(true);
    }
  });
});

describe("the question carries the network it was asked about", () => {
  it("hands the walk's own network and ports to the callback", () => {
    /* NOT A DETAIL. The picker filters its candidates by `networkHexes`/`networkPorts`; a glow that asked
       "does any tile fit this hex" without them would light hexes whose picker then opens empty -- trading
       one wrong promise for another. */
    const seen: { network: number; ports: number }[] = [];
    reach({
      hasPlaceableTile: (_q, _r, network, ports) => {
        seen.push({ network: network.size, ports: ports.size });
        return true;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.network).toBeGreaterThan(0);
    }
  });

  it("asks about every candidate and no more", () => {
    // One question per hex that passed the ground test -- the filter is not re-walking the board.
    const asked: string[] = [];
    const result = reach({
      hasPlaceableTile: (q, r) => {
        asked.push(`${q},${r}`);
        return true;
      },
    });
    expect(asked.length).toBe(result.hexes.size);
    expect(new Set(asked).size).toBe(asked.length);
  });
});

describe("omitting the callback keeps the old behaviour", () => {
  it("falls back to the ground test alone", () => {
    /* Every existing caller and fixture relies on this, and it is the conservative answer where there is no
       engine to ask -- the same reasoning #7 gives for `certificateBreakdown`'s optional zone lookup. */
    expect(reach({ hasPlaceableTile: undefined }).hexes.size).toBeGreaterThan(0);
  });

  it("still reports unconstrained for a corporation with no tokens", () => {
    // The callback must not be reached at all on this path: there is no network to filter.
    let called = false;
    const result = layableHexes({
      mapGrid: boardWith([]),
      stationHexes: [],
      hasPlaceableTile: () => {
        called = true;
        return true;
      },
    });
    expect(result.unconstrained).toBe(true);
    expect(called).toBe(false);
  });
});
