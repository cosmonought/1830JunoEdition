/** @jest-environment node */
//
// The C&StL's lay is extra: the Track step survives it. No React.
//
// ==================================================================
//  DESIGN NOTE 776 (harness): ONE LINE, TWO RULES
// ==================================================================
//
// REPORTED: "CSL's special power is supposed to allow for a SECOND track lay, but in my playthrough using
// its power advanced the Lay Track subphase completely."
//
// THE CONTROL CASE MATTERS AS MUCH AS THE FIX, and more than usual here. The line being changed is the same
// one that enforces "one tile per turn" -- the rule #766 had to restore after lays went unlimited -- so a
// fix that let the ordinary lay stop ending the step would reintroduce a worse bug than the one reported.
// Every test that asserts the bonus lay HOLDS the step has a twin asserting the plain lay ENDS it.
//
// AND ABSENT MUST STILL MEAN ORDINARY. Rooms have logs full of `LayTile` messages written before this field
// existed, and a replay of one of them has to reach the same board it reached when it was recorded. Pinned
// on the literal shape rather than on a constructor, because a helper that defaults the flag would make the
// test agree with itself rather than with the old entries.

import { applySandboxAction } from "./sandboxSession";
import { isBonusLay, layEndsTrackStep, BONUS_LAY_PRIVATE_ID } from "./bonusLay";
import type { GameStateResponse } from "./gameState";

const CSL_OWNER = 4;

/** A corporation mid-turn on the Track step. */
function board(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "12000",
    private_companies: [
      { private_id: BONUS_LAY_PRIVATE_ID, name: "Champlain & St. Lawrence", owner_protocol_id: CSL_OWNER },
    ],
    current_round_type: "OperatingRound",
    operating_sub_phase: "Track",
    macro_round_number: 2,
    sub_round_index: 0,
    active_player_index: 0,
    active_operating_order: [CSL_OWNER],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: CSL_OWNER,
        ticker: "NYNH",
        is_floated: true,
        president: "p1",
        par_value: "82",
        home_hex_label: "B20",
        ipo_pool_percentage: 40,
        bank_pool_percentage: 0,
        treasury: "500",
        last_route_revenue: "0",
        player_holdings: [{ player: "p1", percentage: 60 }],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
      },
    ],
    ...over,
  } as unknown as GameStateResponse;
}

const plainLay = {
  LayTile: { game_id: 1, protocol_id: CSL_OWNER, q: 1, r: 1, tile_id: 7, orientation: 0 },
} as never;

const bonusLayMsg = {
  LayTile: {
    game_id: 1,
    protocol_id: CSL_OWNER,
    q: 1,
    r: 1,
    tile_id: 7,
    orientation: 0,
    bonus_lay: true,
  },
} as never;

describe("the step ends on the lay that was the lay", () => {
  it("holds the Track step for the C&StL's bonus lay", () => {
    /* THE REPORT. The cursor is what withdraws the Lay Track controls, so ending the step here IS the second
       lay being taken away. */
    expect(applySandboxAction(board(), bonusLayMsg).operating_sub_phase).toBe("Track");
  });

  it("still ends it for an ordinary lay", () => {
    /* THE CONTROL, and the one that would matter more if it broke: this is the "one tile per turn" rule, and
       #766 is the note about what happens when it stops holding. */
    expect(applySandboxAction(board(), plainLay).operating_sub_phase).toBe("Tokens");
  });

  it("ends it for a lay with the flag explicitly false", () => {
    const explicit = {
      LayTile: { ...(plainLay as never as { LayTile: object }).LayTile, bonus_lay: false },
    } as never;
    expect(applySandboxAction(board(), explicit).operating_sub_phase).toBe("Tokens");
  });

  it("ends it for a message written before the field existed", () => {
    /* #712's rule for `quantity`, applied again: absent means ordinary. Every log entry already recorded
       omits this, and a replay must reach the board it reached when it was written. */
    const legacy = JSON.parse(JSON.stringify(plainLay));
    expect("bonus_lay" in legacy.LayTile).toBe(false);
    expect(applySandboxAction(board(), legacy).operating_sub_phase).toBe("Tokens");
  });

  it("lets the ordinary lay follow the bonus one", () => {
    /* THE WHOLE POINT: two tiles in one turn. The bonus lay leaves the cursor on Track, and the placement
       that follows is the corporation's own and ends the step. */
    const afterBonus = applySandboxAction(board(), bonusLayMsg);
    expect(afterBonus.operating_sub_phase).toBe("Track");
    const afterOrdinary = applySandboxAction(afterBonus, plainLay);
    expect(afterOrdinary.operating_sub_phase).toBe("Tokens");
  });

  it("does not grant a third lay", () => {
    // One bonus, one ordinary. A second ordinary lay has no step left to take.
    const twice = applySandboxAction(applySandboxAction(board(), bonusLayMsg), plainLay);
    expect(applySandboxAction(twice, plainLay).operating_sub_phase).not.toBe("Track");
  });
});

describe("the rule reads the message, not the board", () => {
  it("recognises the flag", () => {
    expect(isBonusLay(bonusLayMsg)).toBe(true);
    expect(layEndsTrackStep(bonusLayMsg)).toBe(false);
  });

  it("treats every other message as ordinary", () => {
    for (const msg of [plainLay, { PassTurn: {} }, { BuyStock: {} }, {}]) {
      expect(isBonusLay(msg as never)).toBe(false);
      expect(layEndsTrackStep(msg as never)).toBe(true);
    }
  });

  it("survives a malformed message", () => {
    expect(isBonusLay({ LayTile: null } as never)).toBe(false);
    expect(isBonusLay(null as never)).toBe(false);
  });

  it("does not infer the bonus from the hex", () => {
    /* THE ALTERNATIVE THAT WAS REJECTED, pinned so it cannot creep back. A lay on the C&StL's own hex by the
       corporation that owns it is STILL ordinary without the flag, because a connected B-20 lay can
       legitimately be the corporation's normal placement -- and inferring otherwise hands out a free tile. */
    const onCslHex = {
      LayTile: { game_id: 1, protocol_id: CSL_OWNER, q: 0, r: 0, tile_id: 7, orientation: 0 },
    } as never;
    expect(isBonusLay(onCslHex)).toBe(false);
  });
});

describe("the shell says which lay it is", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: the notes quote the rule while explaining it.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("flags the lay reached through the csl-tile errand", () => {
    expect(APP).toContain('homeStationPlacement.abilityKey === "csl-tile"');
  });

  it("sends the flag on both the sandbox and the chain path", () => {
    /* Two dispatch paths, and #391's lesson about two copies: the chain one is the copy that gets forgotten,
       because nothing in a sandbox playtest exercises it. */
    expect(APP.match(/\.\.\.\(bonusLay \? \{ bonus_lay: true \} : \{\}\)/g)?.length).toBe(2);
  });

  it("does not flag the D&H's lay", () => {
    /* #548: the D&H's tile CONSUMES the corporation's placement -- only its token is free. The two privates
       are exact opposites and conflating them is the easy mistake.
       SCOPED TO THE EXPRESSION, and the first version was not. It asserted that `abilityKey === "dh-tile"`
       appeared NOWHERE in `App.tsx`, using a whole-file absence as a proxy for a property of one line -- so
       #818 broke it by testing that same key for an unrelated reason (raising the free-station question after
       the D&H's lay lands, which is a fact about the TOKEN and says nothing about a bonus lay).
       A proxy assertion fails on the first legitimate use of the thing it was standing in for, and it fails
       in a way that reads as a real regression. The property was always "the `bonusLay` expression is
       C&SL-only"; that is what is checked now. */
    /* The end anchor is searched FROM the start anchor. `if (sandbox) {` occurs earlier in the file too, so
       a bare `indexOf` produced a backwards range and an empty slice -- which then failed the `toContain`
       and would have silently passed the `not.toContain` beside it. Half of a slice guard is worse than
       none: #785's harness lost a whole assertion the same way. */
    const start = APP.indexOf("const bonusLay =");
    const bonus = APP.slice(start, APP.indexOf("if (sandbox) {", start));
    expect(start).toBeGreaterThan(-1);
    expect(bonus.length).toBeGreaterThan(0);
    expect(bonus).toContain('abilityKey === "csl-tile"');
    expect(bonus).not.toContain("dh-tile");
  });

  it("omits the field entirely for an ordinary lay", () => {
    // Rather than sending `bonus_lay: false`: an ordinary entry must look like the ones written before #776.
    expect(APP).not.toContain("bonus_lay: false");
  });

  it("leaves the second lay to the private's own surface (design note #834)", () => {
    /* #832 DERIVED A COUNT HERE -- `trackLaysThisTurn`, one ordinarily and two while the C&SL's extra was
       unspent -- so the action bar could label its jump "Lay 2 Track".
       WITHDRAWN BY THE PERSON WHO ASKED FOR IT: "There should actually never be a 'Lay 2 Track' button
       because a 'second' track lay is ONLY provided by the special power of a private company, for which
       we've already built a modal. The Action Bar should be used for the standard actions, let's leave the
       Special Powers where they are without trying to display them again."
       #832 WAS RIGHT ABOUT THE GAP AND WRONG ABOUT THE REMEDY. Nothing on screen said the C&SL's lay is
       extra; the place to say it is the power's own surface (#817's errand, #818's modal), and putting it on
       the bar as well is the two-surfaces-one-question failure of #815 and #829, reached deliberately.
       THE RULE IS UNTOUCHED -- the tests above still pin `bonus_lay` on both dispatch paths. Only the second
       DISPLAY of it is gone, which is what makes this a withdrawal rather than a regression. */
    expect(APP).not.toContain("trackLaysThisTurn");
    expect(APP).not.toContain("trackLays=");
  });

  it("keeps the catalog's description in step with the code", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const catalog = fs.readFileSync(path.join(__dirname, "privateCatalog.ts"), "utf8");
    // The sentence that was true all along and that nothing asked.
    expect(catalog).toContain("bonus rather than a substitute");
    expect(catalog).toContain("so it may lay two");
  });
});
