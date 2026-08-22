/** @jest-environment node */
//
// The rule, and the reducer arm that charges it. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 723 (harness): PAID ONCE, AND BY THE THING THAT PAYS
// ==================================================================
//
// REPORTED, twice: "terrain costs only charge a corporation the first time anything happens on the hex (be it
// a track lay or an upgrade over a preprinted one, like G19). It is wrong to keep charging the terrain cost
// for every lay track action on a terrain hex." — "I mentioned this before but it doesn't seem to have been
// addressed."
//
// THE SECOND SENTENCE IS THE ONE THAT SHAPES THIS FILE. It HAD been addressed -- in `pendingTileCost`, which
// is the number the player is SHOWN, and nowhere in the reducer that moves the money. So there was already a
// green harness asserting an upgrade is free, and it proved nothing about the debit. Every case below
// therefore runs the REDUCER and reads a treasury; the projection is checked separately, against the same
// rule module, so the two cannot drift apart again.
//
// AND THE INTERESTING ASSERTION IS THE SECOND LAY. A first charge is right in both the broken and the fixed
// version, so any test that lays once passes either way -- which is roughly how a wrong rule survived a
// harness. The cases that discriminate all lay twice.

import { applySandboxAction } from "./sandboxSession";
import { pendingTileCost } from "./pendingTileCost";
import { hasPaidTerrain, terrainFeeDue, withTerrainPaid } from "./terrainFee";
import {
  MOUNTAIN_BUILD_FEE,
  RIVER_BUILD_FEE,
  terrainBuildFeeAt,
} from "../components/hexBoardData";
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

/** G13 -- a mountain. G19 -- New York, a RIVER hex carrying a preprinted yellow tile. */
const MOUNTAIN = { q: 3, r: 6 };
const G19 = { q: 6, r: 6 };
const PLAIN = { q: -3, r: 7 };

const CO = 1;

function board(treasury = 2000): GameStateResponse {
  return {
    public_companies: [
      { company_id: CO, ticker: "PRR", treasury: String(treasury), player_holdings: [] },
    ],
    player_addresses: [],
    player_cash: [],
    active_player_index: 0,
  } as unknown as GameStateResponse;
}

function treasuryOf(state: GameStateResponse): number {
  return Number(state.public_companies[0].treasury);
}

function lay(state: GameStateResponse, at: { q: number; r: number }, tileId = 8): GameStateResponse {
  return applySandboxAction(state, {
    LayTile: { game_id: 1, protocol_id: CO, q: at.q, r: at.r, tile_id: tileId, orientation: 0 },
  } as never);
}

describe("the ground is charged once", () => {
  it("charges the posted fee on the first build", () => {
    // The case that was always right, kept as the control the discriminating cases are measured against.
    const after = lay(board(2000), MOUNTAIN);
    expect(treasuryOf(after)).toBe(2000 - MOUNTAIN_BUILD_FEE);
  });

  it("charges nothing on the upgrade", () => {
    /* THE REPORT. The old reducer took $120 here and the preview said $0. Anything that lays only once passes
       either way, which is why this is the assertion the fix is really about. */
    const after = lay(lay(board(2000), MOUNTAIN), MOUNTAIN, 16);
    expect(treasuryOf(after)).toBe(2000 - MOUNTAIN_BUILD_FEE);
  });

  it("charges nothing however many times the hex is built on", () => {
    /* The property rather than one more example -- a rule implemented as "skip the second" and not "skip every
       later one" would pass the case above and fail here. */
    let state = board(2000);
    for (let at = 0; at < 5; at += 1) state = lay(state, MOUNTAIN);
    expect(treasuryOf(state)).toBe(2000 - MOUNTAIN_BUILD_FEE);
  });

  it("keeps each hex's fee separate", () => {
    /* A set keyed on the hex, not a "have we charged terrain yet" flag -- which is the shortest wrong
       implementation of this rule and would make the whole map free after one mountain. */
    const after = lay(lay(board(2000), MOUNTAIN), G19);
    expect(treasuryOf(after)).toBe(2000 - MOUNTAIN_BUILD_FEE - RIVER_BUILD_FEE);
  });

  it("charges nothing at all on clear ground", () => {
    expect(treasuryOf(lay(board(2000), PLAIN))).toBe(2000);
  });
});

describe("a preprinted hex has still never been paid for", () => {
  it("charges the river fee on the first upgrade of G19", () => {
    /* THE REPORT'S OWN PARENTHESIS: "be it a track lay or an upgrade over a preprinted one, like G19". G19 is
       New York -- printed yellow, and `upgrade=cost:80,terrain:water` on the real board. Preprinted track is
       not somebody having already paid; nobody has. */
    expect(terrainBuildFeeAt(G19.q, G19.r)).toBe(RIVER_BUILD_FEE);
    expect(treasuryOf(lay(board(2000), G19))).toBe(2000 - RIVER_BUILD_FEE);
  });

  it("charges nothing on the green upgrade after that", () => {
    const after = lay(lay(board(2000), G19), G19, 54);
    expect(treasuryOf(after)).toBe(2000 - RIVER_BUILD_FEE);
  });
});

describe("the ledger records paid ground and only paid ground", () => {
  it("records a hex whose fee was charged", () => {
    expect(hasPaidTerrain(lay(board(), MOUNTAIN).terrain_fees_paid, MOUNTAIN.q, MOUNTAIN.r)).toBe(
      true,
    );
  });

  it("does not record clear ground", () => {
    /* The invariant that keeps the set readable: a key is here BECAUSE a fee was paid. Recording free hexes
       would make it a build log, which is a different thing that nothing needs. */
    expect(lay(board(), PLAIN).terrain_fees_paid ?? []).toEqual([]);
  });

  it("does not grow when the same hex is laid again", () => {
    /* REPLAY SAFETY, stated as a property of the data. The Undo path replays the whole log, so an arm that
       appended unconditionally would grow this array without bound across rebuilds. */
    const twice = lay(lay(board(), MOUNTAIN), MOUNTAIN);
    expect(twice.terrain_fees_paid).toHaveLength(1);
  });

  it("survives a replay of the same log", () => {
    /* THE REASON THIS LIVES IN STATE AT ALL. Replaying produces the same treasury as playing, because the
       answer is a function of the log rather than of `mapGrid` -- which does not advance action-by-action
       inside the rebuild loop and would have made this diverge on every Undo. */
    const played = lay(lay(board(2000), MOUNTAIN), MOUNTAIN, 16);
    let replayed = board(2000);
    replayed = lay(replayed, MOUNTAIN);
    replayed = lay(replayed, MOUNTAIN, 16);
    expect(treasuryOf(replayed)).toBe(treasuryOf(played));
  });
});

describe("the preview quotes the figure the debit will use", () => {
  const EMPTY = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

  it("agrees with the reducer on an unpaid hex", () => {
    /* THE PAIRING #723 EXISTS TO GUARANTEE. Before it, these two disagreed by the whole fee on an upgrade --
       and the projection was the half a player could see, which is what made the bug survive a report. */
    const state = board(2000);
    const quoted = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 2000, state.terrain_fees_paid);
    expect(quoted.fee).toBe(2000 - treasuryOf(lay(state, MOUNTAIN)));
  });

  it("agrees with the reducer on a paid hex", () => {
    const once = lay(board(2000), MOUNTAIN);
    const quoted = pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 2000, once.terrain_fees_paid);
    expect(quoted.fee).toBe(0);
    expect(treasuryOf(lay(once, MOUNTAIN, 16))).toBe(treasuryOf(once));
  });

  it("quotes the posted price when it cannot see the ledger", () => {
    /* OMITTED MEANS NOTHING PAID, and it is the safe direction: a caller with no state should say what the
       ground costs rather than assume somebody else has settled it. Quoting $0 on a fee-bearing hex would be a
       promise the reducer then breaks. */
    expect(pendingTileCost(EMPTY, MOUNTAIN.q, MOUNTAIN.r, 2000).fee).toBe(MOUNTAIN_BUILD_FEE);
  });
});

describe("the rule module holds up on its own", () => {
  it("returns nothing for ground already paid", () => {
    const paid = withTerrainPaid([], MOUNTAIN.q, MOUNTAIN.r, MOUNTAIN_BUILD_FEE);
    expect(terrainFeeDue(paid, MOUNTAIN.q, MOUNTAIN.r, terrainBuildFeeAt)).toBe(0);
  });

  it("treats a null ledger as nothing paid", () => {
    expect(terrainFeeDue(null, MOUNTAIN.q, MOUNTAIN.r, terrainBuildFeeAt)).toBe(
      MOUNTAIN_BUILD_FEE,
    );
  });

  it("never returns a negative or non-finite fee", () => {
    // The lookup is a mirror of the contract's table; this is the guard for a hex it does not know.
    expect(terrainFeeDue(null, 999, 999, () => Number.NaN)).toBe(0);
    expect(terrainFeeDue(null, 999, 999, () => -80)).toBe(0);
  });
});
