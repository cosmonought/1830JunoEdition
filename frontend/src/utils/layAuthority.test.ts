/** @jest-environment node */
//
// A tile lay the rules refuse does not land, does not charge, and does not end the step. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 757 (harness): CLOSING THE DOOR, NOT THE BUTTON
// ==================================================================
//
// #756 stopped the radial selector OFFERING a rotation that crosses an impassable border, and its own summary
// said what was still missing: "this closes the button, not the door". Every placement rule in this game --
// the colour step, centre preservation, path preservation, the board's rim, the four barriers -- lived in a
// filter that decides which chips appear. A `LayTile` built by hand, replayed from a stale tab, or dispatched
// by any second control written later went straight through.
//
// THE SAME GAP #748 FOUND ON THE SELL SIDE, and the one #712 had already closed for buys. Three reports, one
// shape, and this is the third of the three surfaces.
//
// A LAY TOUCHES THREE THINGS, which is why the gate is not in the arm: the terrain fee (`applyOneAction`), the
// sub-phase cursor (`settleOperatingCursor`), and the tile grid, which is a SEPARATE ATOM the shell owns.
// Refusing in the arm alone would have charged the fee and advanced the step for a tile that was never
// placed -- the cross-atom split #748a had to solve for the market chart, arriving again. So the tests below
// check all three, and the grid one matters most: it is the atom that would silently disagree.

import { applySandboxAction, applySandboxLayTile } from "./sandboxSession";
import { filterSandboxPlacements } from "../components/sandboxTileLegality";
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const PRR = 1;
/** D12 carries two of the four impassable borders, on edges 1 and 2. */
const D12 = { q: 4, r: 3 };

const bare = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

function board(): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [PRR],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: "Track",
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        par_value: "100",
        ipo_pool_percentage: 0,
        bank_pool_percentage: 0,
        treasury: "1000",
        owned_trains: ["4"],
        player_holdings: [{ player: "p1", percentage: 100 }],
        station_token_hexes: [],
      },
    ],
  } as unknown as GameStateResponse;
}

/** The real predicate the shell builds, against a real board. */
const refusal = (grid: MapGridResponse) => (q: number, r: number, tileId: number, orientation: number) =>
  filterSandboxPlacements([{ tile_id: tileId, orientation }], {
    mapGrid: grid,
    q,
    r,
    era: "Yellow",
  } as never).length === 0;

/** A tile-and-rotation on D12 that puts rail across a barrier, found rather than assumed. */
const ILLEGAL = (() => {
  for (const tile_id of [7, 8, 9]) {
    for (let orientation = 0; orientation < 6; orientation += 1) {
      if (refusal(bare)(D12.q, D12.r, tile_id, orientation)) return { tile_id, orientation };
    }
  }
  return null;
})();

/** And one the rules allow, so every refusal below has a control. */
const LEGAL = (() => {
  for (const tile_id of [7, 8, 9]) {
    for (let orientation = 0; orientation < 6; orientation += 1) {
      if (!refusal(bare)(D12.q, D12.r, tile_id, orientation)) return { tile_id, orientation };
    }
  }
  return null;
})();

const lay = (placement: { tile_id: number; orientation: number }) =>
  ({
    LayTile: {
      game_id: 1,
      protocol_id: PRR,
      q: D12.q,
      r: D12.r,
      tile_id: placement.tile_id,
      orientation: placement.orientation,
    },
  }) as never;

describe("the fixture is real", () => {
  it("found both an illegal and a legal placement on D12", () => {
    /* Read back rather than trusted. If D12 offered no illegal rotation the refusal tests would pass while
       testing nothing, and if it offered no legal one the controls would be meaningless. */
    expect(ILLEGAL).not.toBeNull();
    expect(LEGAL).not.toBeNull();
  });
});

describe("a refused lay leaves the tile grid alone", () => {
  it("returns the same grid, by identity", () => {
    /* IDENTITY IS THE ASSERTION, not just equality: the caller is a `setMapGrid` updater, so an equal-but-new
       object would repaint the canvas for a lay that did not happen. */
    const next = applySandboxLayTile(
      bare,
      D12.q,
      D12.r,
      ILLEGAL!.tile_id,
      ILLEGAL!.orientation,
      refusal(bare),
    );
    expect(next).toBe(bare);
  });

  it("still places a legal one, which is the control", () => {
    const next = applySandboxLayTile(
      bare,
      D12.q,
      D12.r,
      LEGAL!.tile_id,
      LEGAL!.orientation,
      refusal(bare),
    );
    expect(next).not.toBe(bare);
    expect(next.tiles).toHaveLength(1);
  });

  it("has no opinion when no predicate is injected", () => {
    /* #7's rule: the legality engine lives in `components/` and `utils/` may not import it, so the check
       arrives as a callback. Absent must mean "no opinion" rather than "refuse" -- otherwise every existing
       caller and every fixture would silently start failing. */
    const next = applySandboxLayTile(bare, D12.q, D12.r, ILLEGAL!.tile_id, ILLEGAL!.orientation);
    expect(next.tiles).toHaveLength(1);
  });
});

describe("a refused lay charges nothing and ends nothing", () => {
  it("leaves the whole state untouched", () => {
    /* THE CROSS-ATOM HALF. The terrain fee and the sub-phase cursor both hang off this message, and both
       would have fired for a tile that never landed. Identity covers all of it at once. */
    const before = board();
    expect(applySandboxAction(before, lay(ILLEGAL!), { layRefused: refusal(bare) })).toBe(before);
  });

  it("does not advance the Operating Round step", () => {
    const before = board();
    const after = applySandboxAction(before, lay(ILLEGAL!), { layRefused: refusal(bare) });
    expect(after.operating_sub_phase).toBe("Track");
  });

  it("advances it on a legal lay, which is the control", () => {
    /* Without this, a reducer that refused every lay would satisfy every test above and quietly freeze the
       Track step for the rest of the game. */
    const after = applySandboxAction(board(), lay(LEGAL!), { layRefused: refusal(bare) });
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("still charges the terrain fee on a legal lay", () => {
    // The fee arm is downstream of the gate; refusing must not have disarmed it for legal placements.
    const after = applySandboxAction(board(), lay(LEGAL!), { layRefused: refusal(bare) });
    expect(after.public_companies[0].treasury).toBeDefined();
  });
});

describe("the gate judges against the board as it stands", () => {
  it("uses the grid it is given, not a fixed one", () => {
    /* #723's trap, which #757 had to solve before it could ship: "`ctx.mapGrid` does not advance action by
       action inside the Undo rebuild loop, so a board lookup here would be right live and wrong on every
       rebuild." A replay lays tile after tile in one burst; a predicate reading React state would judge each
       one against the board from before the burst and refuse legitimate upgrades. The shell threads a REF for
       this reason -- here it shows up as the predicate simply taking the grid as an argument. */
    const laid = applySandboxLayTile(bare, D12.q, D12.r, LEGAL!.tile_id, LEGAL!.orientation);
    expect(laid.tiles).toHaveLength(1);

    /* On the UPDATED board the same yellow tile is no longer legal -- a hex already carrying yellow needs
       green next. Judged against the stale board it would still look fine, which is the bug this guards. */
    expect(refusal(laid)(D12.q, D12.r, LEGAL!.tile_id, LEGAL!.orientation)).toBe(true);
    expect(refusal(bare)(D12.q, D12.r, LEGAL!.tile_id, LEGAL!.orientation)).toBe(false);
  });
});

describe("the surfaces share one answer", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // #490a: the notes quote the old arrangement and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  };

  it("builds the predicate once in the shell", () => {
    /* THE STRUCTURAL HALF. Two predicates spelled separately for the grid and the state is the #748a failure
       exactly -- one atom accepting what the other refused, permanently out of step. */
    const app = read("App.tsx");
    expect(app).toContain("const layRefused = (q: number, r: number, tileId: number, orientation: number)");
    expect(app).toContain("lay.orientation,\n            layRefused,");
    expect(app).toContain("layRefused,\n          });");
  });

  it("reads the grid through the ref", () => {
    // React state is stale inside a replay burst; the market atom already carries a ref for the same reason.
    expect(read("App.tsx")).toContain("mapGrid: mapGridRef.current,");
  });

  it("gates before anything settles", () => {
    expect(read("utils/sandboxSession.ts")).toContain(
      'if ("LayTile" in msg && ctx?.layRefused) {',
    );
  });
});
