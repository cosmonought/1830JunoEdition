/** @jest-environment node */
//
// The blocking rule and the walk that honours it. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 729 (harness): A WALL, NOT A HOLE
// ==================================================================
//
// REPORTED: "In Lay Track, corporations' networks are not being blocked by tokened out cities. A network is
// defined in the rulebook as the hexes a theoretical infinite-length train could reach on its run, so tokened
// out hexes block this train as they should all other trains."
//
// THE SHAPE OF THE FIX IS WHAT THIS FILE PINS, and it is easy to get half right. "Blocked" does not mean
// "absent": a train may END its run in a city it cannot pass through, and a corporation may still upgrade that
// tile. So a blocked city stays IN the network and loses its EXITS. A fix that deleted the hex would pass any
// test asking "is the far side excluded" and would silently forbid a legal tile lay on the blocked hex itself.
// Every walk case below therefore asserts BOTH halves.
//
// AND THE RULE'S THREE CLAUSES ARE TESTED SEPARATELY, because each has an obvious wrong version:
//   "somebody else is here"      instead of "the slots are full"  -- blocks a two-slot city with one rival
//   "every slot is filled"       instead of "filled by others"    -- blocks a corporation by its own token
//   "no room"                    instead of "not a city"          -- blocks every town and every plain hex

import { cityBlockerFor, cityBlocksThrough, type TokenHolder } from "./cityBlocking";
import { reachableTrack } from "./trackReach";
import type { MapGridResponse } from "../components/hexContractTypes";

const ME = 1;
const RIVAL = 2;
const THIRD = 3;

function holder(id: number, hexes: [number, number][]): TokenHolder {
  return { company_id: id, station_token_hexes: hexes };
}

/** One city with `slots` room at (5,5); everything else is bare ground. */
function blocking(
  companies: TokenHolder[],
  slots = 1,
  cityOf: (c: TokenHolder, q: number, r: number) => number | undefined = () => undefined,
) {
  return cityBlockerFor({
    actingCompanyId: ME,
    companies,
    slotsAt: (q, r, city) => (q === 5 && r === 5 && city === 0 ? slots : 0),
    cityOf,
  });
}

describe("a city blocks only when it is FULL, and full of somebody else", () => {
  it("blocks a one-slot city holding ONE rival", () => {
    /* The commonest wall on an 1830 board, and worth stating because a design note of mine once implied it
       took two. REPORTED: "a blocked city does not need 'two rival tokens', it just needs rival tokens equal
       to station slots. This might be at a city with only one station: it still blocks all other
       corporations." Most yellow city tiles have one slot, so this is the ordinary case, not the edge. */
    expect(blocking([holder(RIVAL, [[5, 5]])])(5, 5, 0)).toBe(true);
  });

  it("does NOT block a two-slot city with one rival in it", () => {
    /* THE FIRST WRONG VERSION. "Somebody else is here" is the tempting predicate and it walls off every
       shared city on the board -- New York, Philadelphia, Chicago -- from the moment one rival arrives. */
    expect(blocking([holder(RIVAL, [[5, 5]])], 2)(5, 5, 0)).toBe(false);
  });

  it("blocks a two-slot city once two rivals fill it", () => {
    expect(blocking([holder(RIVAL, [[5, 5]]), holder(THIRD, [[5, 5]])], 2)(5, 5, 0)).toBe(true);
  });

  it("never blocks a corporation standing in its own city", () => {
    /* THE SECOND WRONG VERSION, and the one that would be worst in play: a president who spent $100 on a token
       precisely so their trains could pass would find it walling them out. Their own token is a key. */
    expect(blocking([holder(ME, [[5, 5]])])(5, 5, 0)).toBe(false);
    expect(blocking([holder(ME, [[5, 5]]), holder(RIVAL, [[5, 5]])], 2)(5, 5, 0)).toBe(false);
  });

  it("never blocks a small town or plain track", () => {
    /* THE THIRD WRONG VERSION. `slots === 0` means "not a city"; read as "a city with no room" it walls off
       every hex on the board that nobody can token in the first place. One sign apart in the obvious code. */
    expect(blocking([holder(RIVAL, [[9, 9]])])(9, 9, 0)).toBe(false);
  });

  it("says nothing about a city nobody is in", () => {
    expect(blocking([])(5, 5, 0)).toBe(false);
  });
});

describe("a token of unknown city is counted carefully", () => {
  it("counts it on a hex that has only one city", () => {
    // #134: `undefined` means the chain did not say. With one city there is only one thing it can mean.
    expect(blocking([holder(RIVAL, [[5, 5]])])(5, 5, 0)).toBe(true);
  });

  it("does NOT guess on a hex with two cities", () => {
    /* Guessing invents a wall on one half of an OO tile or misses one on the other, and #134's whole point is
       that `undefined` must stay distinguishable from `0`. Refusing to block is the recoverable error: the
       reducer still refuses an illegal run, whereas an invented wall deletes legal track invisibly. */
    const twoCity = cityBlockerFor({
      actingCompanyId: ME,
      companies: [holder(RIVAL, [[5, 5]])],
      slotsAt: () => 1,
      cityOf: () => undefined,
    });
    expect(twoCity(5, 5, 0)).toBe(false);
  });

  it("uses the recorded city when the chain HAS said", () => {
    const known = cityBlockerFor({
      actingCompanyId: ME,
      companies: [holder(RIVAL, [[5, 5]])],
      slotsAt: () => 1,
      cityOf: () => 1,
    });
    expect(known(5, 5, 1)).toBe(true);
    expect(known(5, 5, 0)).toBe(false);
  });
});

describe("the walk stops AT the wall and keeps the hex", () => {
  /* A straight line of tile 8s is not needed: what matters is that a blocked arrival contributes its hex and
     no exits, which is a property of the loop rather than of any particular board. `tile_id: 57` is the plain
     yellow the D&H lays and connects two opposite edges. */
  const line = {
    tiles: [
      { q: 5, r: 5, tile_id: 57, orientation: 0 },
      { q: 6, r: 5, tile_id: 57, orientation: 0 },
    ],
  } as unknown as MapGridResponse;

  it("reaches the same hexes as before when nothing blocks", () => {
    /* THE COMPATIBILITY CASE. Omitting the callback must reproduce every pre-#729 caller exactly, or this
       lands as a behaviour change on boards with no tokens at all. */
    const open = reachableTrack(line, [[5, 5]]);
    const withCallback = reachableTrack(line, [[5, 5]], () => false);
    expect(Array.from(withCallback.hexes).sort()).toEqual(Array.from(open.hexes).sort());
  });

  it("never grows the network by blocking", () => {
    /* The property that makes this safe: a blocker can only ever REMOVE reach. A wall is not a door. */
    const open = reachableTrack(line, [[5, 5]]);
    const walled = reachableTrack(line, [[5, 5]], () => true);
    for (const key of Array.from(walled.hexes)) {
      expect(open.hexes.has(key)).toBe(true);
    }
  });

  it("does not block the corporation's own starting city", () => {
    /* A start is entered from INSIDE, so it has no arrival edge and is exempt by construction. A blocker that
       fired on starts would empty the network of a corporation whose home city is shared and full -- which is
       every corporation on a busy board, and would read as the game forgetting they exist. */
    const walled = reachableTrack(line, [[5, 5]], () => true);
    expect(walled.hexes.has("5,5")).toBe(true);
  });
});

describe("the rule is reachable as a plain predicate too", () => {
  it("answers the same as the bound blocker", () => {
    // `cityBlockerFor` is a convenience; a caller with one question should not have to build a closure.
    const input = {
      actingCompanyId: ME,
      companies: [holder(RIVAL, [[5, 5]] as [number, number][])],
      slotsAt: () => 1,
      cityOf: () => 0 as number | undefined,
    };
    expect(cityBlocksThrough(input, 5, 5, 0)).toBe(cityBlockerFor(input)(5, 5, 0));
  });

  it("treats a non-finite slot count as not a city", () => {
    expect(
      cityBlocksThrough(
        {
          actingCompanyId: ME,
          companies: [holder(RIVAL, [[5, 5]])],
          slotsAt: () => Number.NaN,
          cityOf: () => 0,
        },
        5,
        5,
        0,
      ),
    ).toBe(false);
  });
});
