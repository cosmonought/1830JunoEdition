/** @jest-environment node */
//
// The glow set, the C&SL's rule, and the self-lay warning. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 726/727 (harness): TWO POWERS, ONE SHAPE
// ==================================================================
//
// REPORTED: "CSL likely needs similar treatment: it provides the owning corporation with an EXTRA track lay on
// B20 and that track does not need to obey connectivity." And: "the associated hexes could have the rainbow
// glow from the waterfall auction rather than the standard white glow".
//
// HALF OF THE C&SL WAS ALREADY FIXED WHEN THE REPORT ARRIVED, which is the most useful thing here. #725 hung
// the connectivity waiver on the `private-tile` ERRAND rather than on anything named after the D&H, so the
// C&SL inherited it. That was luck, and the tests below make it structural: they assert the waiver against the
// errand, not against either private.
//
// THE GLOW IS TESTED AS A SET, not as pixels. What can be got wrong here is WHICH hexes are marked and when
// they stop being marked -- a mark that outlives its permission is #724 by another route -- and that is set
// arithmetic. The stroke itself is asserted as source, like every other canvas rule in this project.

import {
  CSL_HEX_LABEL,
  CSL_POWER_DESCRIPTION,
  CSL_PRIVATE_ID,
  DH_HEX_LABEL,
  cslPowerState,
  privateSelfLayWarning,
} from "./dhPower";
import { PRIVATE_POWER_GLOW_STOPS, privatePowerGlowKeys } from "./privatePowerGlow";
import { privateHexFor } from "./privateReservations";

const B20 = privateHexFor(CSL_PRIVATE_ID);

describe("the C&SL's lay is the D&H's shape without the station", () => {
  it("is available on a bare B20", () => {
    expect(cslPowerState({ hexBuilt: false, layUsed: false }).layAvailable).toBe(true);
  });

  it("is forfeited once somebody else builds there", () => {
    const state = cslPowerState({ hexBuilt: true, layUsed: false });
    expect(state.forfeited).toBe(true);
    expect(state.layBlockedReason ?? "").toContain(CSL_HEX_LABEL);
  });

  it("is NOT forfeited by its own lay", () => {
    // The same conjunction as the D&H's, and the same bug it prevents.
    expect(cslPowerState({ hexBuilt: true, layUsed: true }).forfeited).toBe(false);
  });

  it("exposes no token half at all", () => {
    /* Modelling a station and leaving it permanently false would invite somebody to wire a button to it. The
       C&SL grants a tile and nothing else. */
    expect(Object.keys(cslPowerState({ hexBuilt: false, layUsed: false })).sort()).toEqual([
      "forfeited",
      "layAvailable",
      "layBlockedReason",
    ]);
  });
});

describe("the two captions differ where the powers differ", () => {
  it("says the C&SL's lay is EXTRA, not a replacement", () => {
    /* THE ONE REAL DIFFERENCE BETWEEN THEM. The D&H's lay replaces the corporation's normal tile lay; the
       C&SL's is on top of it. The old C&SL caption already said so and was right -- unlike the D&H's, which
       #725 had to correct -- so this pins the distinction rather than assuming the two are twins. */
    expect(CSL_POWER_DESCRIPTION).toMatch(/IN ADDITION TO its normal tile lay/);
    expect(CSL_POWER_DESCRIPTION).not.toMatch(/INSTEAD OF/);
  });

  it("names the connection waiver, which the old caption never did", () => {
    expect(CSL_POWER_DESCRIPTION).toMatch(/ignoring track connection rules/i);
  });

  it("names the forfeit", () => {
    expect(CSL_POWER_DESCRIPTION).toMatch(/forfeited/i);
  });
});

describe("the self-lay warning fires for either private", () => {
  const base = {
    q: B20!.q,
    r: B20!.r,
    hex: B20,
    actingOwns: true,
    layAvailable: true,
    forfeited: false,
    usingPower: false,
    privateName: "Champlain & St. Lawrence",
    hexLabel: CSL_HEX_LABEL,
    buttonLabel: `Lay Track (${CSL_HEX_LABEL})`,
  };

  it("warns an owner about to spend the power by ordinary means", () => {
    const warning = privateSelfLayWarning(base) ?? "";
    expect(warning).toContain(CSL_HEX_LABEL);
    expect(warning).toMatch(/forfeits/i);
  });

  it("says nothing when the power itself is being used", () => {
    // The whole point of the errand: warning here would fire on the correct action.
    expect(privateSelfLayWarning({ ...base, usingPower: true })).toBeNull();
  });

  it("says nothing to a corporation that does not own it", () => {
    expect(privateSelfLayWarning({ ...base, actingOwns: false })).toBeNull();
  });

  it("says nothing on any other hex", () => {
    expect(privateSelfLayWarning({ ...base, q: base.q + 1 })).toBeNull();
  });

  it("says nothing once there is nothing left to lose", () => {
    expect(privateSelfLayWarning({ ...base, layAvailable: false })).toBeNull();
    expect(privateSelfLayWarning({ ...base, forfeited: true })).toBeNull();
  });
});

describe("the glow marks a permission, and stops when the permission does", () => {
  const A = { q: 1, r: 1 };
  const B = { q: 2, r: 2 };

  it("marks a usable power's hex", () => {
    expect(privatePowerGlowKeys([{ hex: A, usable: true }]).has("1,1")).toBe(true);
  });

  it("marks nothing for a corporation holding neither private", () => {
    /* The ordinary case, and the one that must cost nothing: most corporations own no hex power, and a set
       that was non-empty for them would repaint the board in the auction's palette for no reason. */
    const keys = privatePowerGlowKeys([
      { hex: A, usable: false },
      { hex: B, usable: false },
    ]);
    expect(keys.size).toBe(0);
  });

  it("drops a power that has been spent or forfeited", () => {
    /* #724 BY ANOTHER ROUTE. A mark that outlives its permission is exactly the stale-badge failure, and the
       caller decides usability precisely so this set cannot develop its own opinion about it. */
    expect(privatePowerGlowKeys([{ hex: A, usable: false }]).size).toBe(0);
  });

  it("marks both when a corporation holds both privates", () => {
    const keys = privatePowerGlowKeys([
      { hex: A, usable: true },
      { hex: B, usable: true },
    ]);
    expect(keys.size).toBe(2);
  });

  it("ignores an entry with no hex on record", () => {
    expect(privatePowerGlowKeys([{ hex: null, usable: true }]).size).toBe(0);
  });
});

describe("the palette is the auction's, and stays the auction's", () => {
  it("runs the full hue circle and closes on itself", () => {
    /* #344's rule, inherited: first and last stop match so a repeating gradient loops seamlessly. Asserted
       here because the board's copy is a CANVAS gradient and the auction's is CSS -- the mechanism cannot be
       shared, so only the list keeps them associated. */
    expect(PRIVATE_POWER_GLOW_STOPS.length).toBeGreaterThanOrEqual(8);
    expect(PRIVATE_POWER_GLOW_STOPS[0]).toBe(
      PRIVATE_POWER_GLOW_STOPS[PRIVATE_POWER_GLOW_STOPS.length - 1],
    );
  });

  it("is the same list the auction card paints", () => {
    /* THE ASSOCIATION IS THE FEATURE. #320 chose this palette because it "runs the full hue circle so it is
       unmistakably not any status colour", and a player meets it on the private company cards -- where they
       acquired the thing this hex is about. Two palettes drifting apart is how that quietly stops being true. */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dashboard = fs.readFileSync(
      path.join(__dirname, "..", "components", "WaterfallAuctionDashboard.tsx"),
      "utf8",
    );
    for (const stop of PRIVATE_POWER_GLOW_STOPS) {
      expect(dashboard.toLowerCase()).toContain(stop.toLowerCase());
    }
  });
});

describe("the board draws the power hexes whether or not they are in reach", () => {
  const renderer = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(
      path.join(__dirname, "..", "components", "HexGridRenderer.tsx"),
      "utf8",
    );
  })();

  it("glows them by OR rather than inside the reach test", () => {
    /* BEING OUT OF REACH IS THE POINT. Nesting this inside `highlighted.has(key)` would mark F16 only on the
       turns a corporation could already build there -- which is every turn the power is worthless. */
    expect(renderer).toContain("layFocus.highlighted.has(key) || poweredHere");
  });

  it("strokes them with the shared stops", () => {
    expect(renderer).toContain("PRIVATE_POWER_GLOW_STOPS.forEach");
  });

  it("still names the D&H's hex as the one the rules module means", () => {
    expect(privateHexFor(3)?.hexLabel).toBe(DH_HEX_LABEL);
  });
});
