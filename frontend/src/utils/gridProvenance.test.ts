/** @jest-environment node */
//
// The board cannot lose tiles. No React, no canvas.
//
// ==================================================================
//  DESIGN NOTE 768 (harness): AN INSTRUMENT, NOT A FIX
// ==================================================================
//
// REPORTED: "in OR2.1, when a corporation laid its second track, all of the laid tiles on the board
// disappeared." Clarified: "I meant its first (and only) tile lay in OR2.1, which was its second tile lay
// action overall."
//
// I DO NOT KNOW THE CAUSE AND THIS FILE DOES NOT CLAIM TO. My first reading -- two lays in one turn -- pointed
// at `rebuildSandbox` not resetting the grid's ref (#767). That is a real bug and is fixed, but it needs an
// Undo to fire and there was no Undo. Two lays, two Operating Rounds apart, nothing between them that touches
// the board.
//
// SO THIS PINS THE INVARIANT INSTEAD, which is exact rather than heuristic: `applySandboxLayTile` either adds
// a tile to a bare hex or replaces the one already on it, so a single message may raise the count by one or
// leave it alone and may NEVER lower it. There is no legitimate path that removes a laid tile.
//
// WHY MEASURING BEATS REASONING HERE, stated because it is the lesson of the whole session: three times a
// theory that fit the symptom turned out false (#746c's double raise, #748b's vacated crown, #767 as a
// diagnosis for this). #750's treasury instrument is what finally caught the phantom $1000, and it caught it
// because it compared two states rather than trusting any arm's account of itself.

import { describeGridChange, gridChangeLine } from "./gridProvenance";
import type { MapGridResponse } from "../components/hexContractTypes";

const grid = (count: number): MapGridResponse =>
  ({
    game_id: 1,
    tiles: Array.from({ length: count }, (_unused, index) => ({
      q: index,
      r: 0,
      tile_id: 7,
      orientation: 0,
    })),
  }) as unknown as MapGridResponse;

const LAY = { LayTile: { game_id: 1, protocol_id: 1, q: 0, r: 0, tile_id: 7, orientation: 0 } };

describe("an ordinary lay", () => {
  it("says nothing when a lay replaces a tile", () => {
    /* An upgrade keeps the count. Silence is right: most messages do not touch the board, and a line per
       message would bury the one line worth reading. */
    expect(describeGridChange(LAY, grid(3), grid(3), "LayTile")).toBeNull();
  });

  it("reports a lay that adds one, without alarm", () => {
    const change = describeGridChange(LAY, grid(3), grid(4), "LayTile");
    expect(change?.unexplained).toBe(false);
    expect(gridChangeLine(change!)).toBe("Board now holds 4 tiles (was 3).");
  });
});

describe("a fall is always a bug", () => {
  it("flags the reported shape", () => {
    /* THE REPORT, as a unit: a lay that leaves the board with fewer tiles than it started with. Whatever
       emptied it, this is the line that will name the message it happened on. */
    const change = describeGridChange(LAY, grid(2), grid(1), "LayTile");
    expect(change?.unexplained).toBe(true);
    expect(gridChangeLine(change!)).toMatch(/Board LOST 1 tile — 2 → 1\. UNEXPLAINED/);
  });

  it("flags a wipe", () => {
    const change = describeGridChange(LAY, grid(5), grid(0), "LayTile");
    expect(gridChangeLine(change!)).toMatch(/Board LOST 5 tiles — 5 → 0\. UNEXPLAINED/);
  });

  it("flags a fall on a message that is not a lay either", () => {
    // The invariant is about the BOARD, not about the message: nothing legitimately removes a laid tile.
    const change = describeGridChange({ PassTurn: {} }, grid(4), grid(3), "PassTurn");
    expect(change?.unexplained).toBe(true);
  });
});

describe("what is allowed is stated positively", () => {
  it("flags a lay that adds two", () => {
    /* One message, one tile. A jump means something dispatched twice or a grid got merged, and either is
       worth seeing. */
    expect(describeGridChange(LAY, grid(1), grid(3), "LayTile")?.unexplained).toBe(true);
  });

  it("flags a RISE on a message that is not a lay", () => {
    /* THE POINT OF A WHITELIST RATHER THAN A BLACKLIST. A new message that grows the board has to justify
       itself here rather than slip through a gap in a list of suspicious cases. */
    expect(describeGridChange({ BuyStock: {} }, grid(1), grid(2), "BuyStock")?.unexplained).toBe(
      true,
    );
  });

  it("copes with a missing grid on either side", () => {
    expect(describeGridChange(LAY, null, null, "LayTile")).toBeNull();
    expect(describeGridChange(LAY, null, grid(1), "LayTile")?.unexplained).toBe(false);
  });
});

describe("the shell is wired to it", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    // #490a: the note explains the invariant in prose and must keep doing so.
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("measures every lay", () => {
    expect(APP).toContain("describeGridChange(msg, mapGridRef.current, nextGrid, fallbackLabel)");
  });

  it("compares the two boards rather than trusting the arm", () => {
    /* #750's rule, restated: an arm asked to declare what it did will declare its bug happily. Both arguments
       are grids, so the line is a diff and cannot be talked out of. */
    expect(APP).toContain("mapGridRef.current, nextGrid");
  });

  it("announces a deliberate reset instead of exempting it", () => {
    /* `rebuildSandbox` empties the board on purpose, so it is outside the invariant -- but a reset firing
       when nobody asked for one is exactly what a player experiences as "the tiles vanished". */
    expect(APP).toContain("Board cleared for a rebuild");
  });
});
