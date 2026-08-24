/** @jest-environment node */
//
// One tile per turn, and the ordering that broke it. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 766 (harness): A GATE THAT JUDGED THE BOARD IT HAD JUST CHANGED
// ==================================================================
//
// REPORTED: "absolutely major regression: corporations are only allowed to lay one tile per turn (except for
// the one special power), and that restriction has been respected until this last build when suddenly the
// number of tile lays is unlimited."
//
// THE RULE WAS NEVER A COUNTER. Laying a tile advances the Operating Round sub-phase from Track to Tokens,
// and that advance IS the one-lay rule -- there is no tally anywhere. So anything that stops the state
// advancing removes the restriction entirely, which is why a refusal bug reads as "unlimited lays" rather
// than as "lays are refused".
//
// #757's PREDICATE READ A REF AT CALL TIME AND THE DISPATCH CALLS IT TWICE. The tile grid is written first,
// which advances `mapGridRef.current` to the board WITH the new tile; `applySandboxAction` then asks the same
// predicate about the same lay and gets "no", because a yellow tile may not go on a hex that now carries
// yellow. The reducer refused a lay it had just performed. The tile still landed -- the grid is a separate
// atom, already written -- and the sub-phase stayed on Track for ever.
//
// TWO KINDS OF TEST, and the second is the one that would have caught it. The behavioural half pins the rule
// through the reducer; the structural half pins the SNAPSHOT, because every behavioural test here passes
// against the broken build if the predicate happens to be given the right board.

import { applySandboxAction } from "./sandboxSession";
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import type { GameStateResponse } from "./gameState";
import type { LegalTilePlacement, MapGridResponse } from "../components/hexContractTypes";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";

const PRR = 1;

const bare = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

/* THE HEX IS SEARCHED OUT OF THE SHIPPED BOARD, not chosen. My first draft picked (6, 6) by eye and it
   accepts no yellow tile at all, so every behavioural test failed on a fixture rather than on the rule --
   the same lesson `soldOutRise.test.ts` records about inventing a market cell. */
const FOUND = (() => {
  for (const hex of STATIC_BOARD_HEXES) {
    for (const tile_id of [7, 8, 9]) {
      for (let orientation = 0; orientation < 6; orientation += 1) {
        const ok =
          filterSandboxPlacements([{ tile_id, orientation } as LegalTilePlacement], {
            mapGrid: bare,
            q: hex.q,
            r: hex.r,
            era: "Yellow",
          } as never).length > 0;
        if (ok) return { q: hex.q, r: hex.r, tile_id, orientation };
      }
    }
  }
  return null;
})();

const HEX = { q: FOUND?.q ?? 0, r: FOUND?.r ?? 0 };

function board(): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Track",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [PRR],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        par_value: "100",
        home_hex_label: "H12",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: "1000",
        owned_trains: ["4"],
        player_holdings: [{ player: "p1", percentage: 100 }],
        station_token_hexes: [[3, 5]],
      },
    ],
  } as unknown as GameStateResponse;
}

/** The placement that search found, on the hex it found it for. */
const LEGAL = FOUND ? { tile_id: FOUND.tile_id, orientation: FOUND.orientation } : null;

const lay = (placement: { tile_id: number; orientation: number }) =>
  ({
    LayTile: {
      game_id: 1,
      protocol_id: PRR,
      q: HEX.q,
      r: HEX.r,
      tile_id: placement.tile_id,
      orientation: placement.orientation,
    },
  }) as never;

/** The predicate as the shell builds it: bound to ONE board for the whole dispatch. */
const refusalAgainst = (grid: MapGridResponse) =>
  (q: number, r: number, tileId: number, orientation: number) =>
    filterSandboxPlacements([{ tile_id: tileId, orientation } as LegalTilePlacement], {
      mapGrid: grid,
      q,
      r,
      era: "Yellow",
    } as never).length === 0;

describe("the fixture is real", () => {
  it("found a hex and a legal yellow placement for it", () => {
    expect(FOUND).not.toBeNull();
  });
});

describe("a lay advances the step, which IS the one-lay rule", () => {
  it("moves Track to Tokens", () => {
    /* THE REGRESSION, as one assertion. There is no counter anywhere -- the restriction is entirely this
       advance, so a state that does not move is a corporation that may lay again. */
    const after = applySandboxAction(board(), lay(LEGAL!), {
      actor: "p1",
      layRefused: refusalAgainst(bare),
    });
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("does not move when the lay is refused, which is the control", () => {
    /* Refusing must still refuse. If this passed too, the fix would have been to disable the gate rather
       than to fix its input. */
    const before = board();
    expect(
      applySandboxAction(before, lay(LEGAL!), { actor: "p1", layRefused: () => true }),
    ).toBe(before);
  });
});

describe("the predicate must be bound to the board BEFORE the action", () => {
  it("answers differently once the tile is on the board", () => {
    /* THE MECHANISM, in two lines. The same lay, the same predicate, two boards -- and that is the whole
       bug: the dispatch wrote the grid, then asked about the lay again. */
    const laid = {
      game_id: 1,
      tiles: [{ q: HEX.q, r: HEX.r, tile_id: LEGAL!.tile_id, orientation: LEGAL!.orientation }],
    } as unknown as MapGridResponse;

    expect(refusalAgainst(bare)(HEX.q, HEX.r, LEGAL!.tile_id, LEGAL!.orientation)).toBe(false);
    expect(refusalAgainst(laid)(HEX.q, HEX.r, LEGAL!.tile_id, LEGAL!.orientation)).toBe(true);
  });

  it("leaves the step stuck when it is bound to the post-lay board", () => {
    /* THE BROKEN BUILD, reconstructed. Every other test in this file passes against it, which is exactly why
       the behavioural half was not enough on its own. */
    const laid = {
      game_id: 1,
      tiles: [{ q: HEX.q, r: HEX.r, tile_id: LEGAL!.tile_id, orientation: LEGAL!.orientation }],
    } as unknown as MapGridResponse;
    const after = applySandboxAction(board(), lay(LEGAL!), {
      actor: "p1",
      layRefused: refusalAgainst(laid),
    });
    expect(after.operating_sub_phase).toBe("Track");
  });
});

describe("the shell captures the board once per dispatch", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: the note quotes the old expression and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("snapshots the grid before building the predicate", () => {
    /* THE FIX, AND THE ONLY TEST THAT WOULD HAVE CAUGHT THIS. A snapshot rather than a reorder: reordering
       the two calls works today and leaves the next reader one edit away from reintroducing it. */
    expect(APP).toContain("const gridBeforeAction = mapGridRef.current;");
    expect(APP).toContain("mapGrid: gridBeforeAction,");
  });

  it("no longer reads the ref inside the predicate", () => {
    const built = APP.slice(
      APP.indexOf("const gridBeforeAction"),
      APP.indexOf("if (\"LayTile\" in msg) {"),
    );
    expect(built).not.toContain("mapGrid: mapGridRef.current,");
  });

  it("still hands the same predicate to both atoms", () => {
    /* #757's point survives: one answer governs the grid, the terrain fee and the sub-phase cursor. What
       changed is only which board that one answer is about. */
    expect(APP).toContain("lay.orientation,\n            layRefused,");
    expect(APP).toContain("layRefused,\n          });");
  });
});
