/** @jest-environment node */
//
// One value question, asked by the tooltip and by the router. No React, no DOM.
//
// ==================================================================
//  DESIGN NOTE 741 (harness): THE TOOLTIP AND THE ROUTER MUST AGREE
// ==================================================================
//
// REPORTED: "The tooltips for the hexes are not updating the (Value: $ ) field to match the current tiles."
//
// THE ASSERTION IS AGREEMENT, for the reason #734 gives about the certificate count: pinning the tooltip
// against a hand-computed number would fix the tooltip and leave the router free to drift, which is exactly
// the state the app was in -- the router was already right. What matters is that both read ONE ladder.
//
// AND THE DISCRIMINATING CASE IS A LAID TILE WITH ITS OWN REVENUE. On a bare hex the two agreed, because the
// short ladder's last rung IS the long ladder's last rung. They diverged only once a tile carrying a figure
// was laid -- which is most tiles, and none of the fixtures anybody had written.

import { describeHexWithValue, hexValueForEra } from "../components/hexGeometry";
import { hexStopValue } from "./sandboxSession";
import { HEX_START_VALUE_OVERRIDE } from "../components/hexBoardData";
import type { MapGridResponse } from "../components/hexContractTypes";

/** Baltimore: printed $30, and a green upgrade that pays more. */
const I15 = { q: 3, r: 8, label: "I15" };

const BARE = { tiles: [] } as unknown as MapGridResponse;

function withTile(tileId: number, revenue?: string): MapGridResponse {
  return {
    tiles: [{ ...I15, tile_id: tileId, orientation: 0, ...(revenue ? { revenue } : {}) }],
  } as unknown as MapGridResponse;
}

describe("both surfaces read one ladder", () => {
  it("agrees on a bare hex", () => {
    /* The case that always worked, kept as the control: the two ladders share a last rung, so a board with
       nothing laid could never have revealed the bug. */
    expect(hexValueForEra(BARE, I15.q, I15.r, "Yellow")).toBe(
      hexStopValue(BARE, I15.label, "Yellow"),
    );
  });

  it("agrees once a tile carrying its OWN revenue is laid", () => {
    /* THE REPORT. The tooltip stopped at the terrain CATEGORY -- "this is a major city hub" -- which is true
       of the hex forever and therefore never news. */
    const laid = withTile(14, "40");
    expect(hexValueForEra(laid, I15.q, I15.r, "Green")).toBe(
      hexStopValue(laid, I15.label, "Green"),
    );
  });

  it("actually CHANGES when the tile does, which is the whole complaint", () => {
    /* A test asserting only agreement would pass against two functions that both ignored the tile. This is the
       one that says the number moves. */
    const before = hexValueForEra(BARE, I15.q, I15.r, "Yellow");
    const after = hexValueForEra(withTile(14, "40"), I15.q, I15.r, "Green");
    expect(before).toBe(HEX_START_VALUE_OVERRIDE.I15);
    expect(after).not.toBe(before);
    expect(after).toBe(40);
  });
});

describe("the ladder is asked in the right order", () => {
  it("prefers the chain's figure over the catalog's", () => {
    /* The chain is the authority on a laid tile; the catalog is this project's mirror of it. Where they
       disagree the chain wins, which is the same rule every other reader of `revenue` follows. */
    expect(hexValueForEra(withTile(14, "70"), I15.q, I15.r, "Green")).toBe(70);
  });

  it("ignores a chain figure of zero", () => {
    /* `"0"` is a plain connector, not a priced stop -- so it must fall THROUGH to the next rung rather than
       reading as "this hex pays nothing". */
    const connector = hexValueForEra(withTile(8, "0"), I15.q, I15.r, "Yellow");
    expect(connector).toBeGreaterThan(0);
  });

  it("falls back to the hex's printed exception", () => {
    // Baltimore's real $30, ahead of the flat terrain bucket.
    expect(hexValueForEra(BARE, I15.q, I15.r, "Yellow")).toBe(30);
  });

  it("scales an off-board terminal with the era instead", () => {
    /* Off-board value RISES with the era -- a different system from the terrain ladder, which is why it is
       asked first and why `hexRouteValue` deliberately returns `null` for those hexes. */
    const early = hexStopValue(BARE, "A1", "Yellow");
    const late = hexStopValue(BARE, "A1", "Brown");
    expect(late).toBeGreaterThanOrEqual(early);
  });
});

describe("the tooltip prints what the ladder returns", () => {
  it("quotes the upgraded value, not the category default", () => {
    const text = describeHexWithValue(I15.q, I15.r, withTile(14, "40"), "Green", []);
    expect(text).toContain("(Value: $40)");
  });

  it("quotes the printed value on a bare hex", () => {
    expect(describeHexWithValue(I15.q, I15.r, BARE, "Yellow", [])).toContain("(Value: $30)");
  });

  it("still suppresses a $0 value", () => {
    /* #103's rule, unchanged: a hex that pays nothing says nothing, rather than printing "(Value: $0)" and
       inviting a player to wonder what they are looking at. */
    const text = describeHexWithValue(-3, 7, BARE, "Yellow", []);
    expect(text).not.toContain("Value: $0");
  });
});
