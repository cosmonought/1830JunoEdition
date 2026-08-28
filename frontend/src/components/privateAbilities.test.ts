// frontend/src/components/privateAbilities.test.ts
//
// ==================================================================
//  DESIGN NOTES 548/725 (harness): THE D&H'S COPY, AND THE TWO HEXES
// ==================================================================
//
// WHAT THIS FILE USED TO BE, and why most of it is gone: it opened as a harness for `PRIVATE_ABILITIES`,
// the ability table inside `PrivatePowerPanel.tsx`, and asserted three things about it -- SCOPE (#441),
// ACTION KEYS (#442) and ROUND (#470). Design note #885 deleted the panel and the table with it, and
// records in full why the table was not rehomed: all four of its rules have living statements in the two
// offer lists and the bar's step switch, and a rules table with no reader is a fifth statement free to
// drift from the four that run.
//
// SO THE ASSERTIONS THAT DIED ARE THE ONES WHOSE SUBJECT DIED. "gives the two hex powers CORPORATION
// scope", "are unique across the whole table", "puts every hex power in the Operating Round" and the rest
// were about the table's shape. Deleting a test whose subject is gone is not a loss of coverage; keeping
// it by inventing a new subject for it is how a harness starts describing something nobody built.
//
// WHAT SURVIVES IS EVERYTHING THAT WAS NEVER REALLY ABOUT THE PANEL:
//
//   THE D&H CAPTION, because #548's copyright measure and #725's asymmetry both live in the sentence, and
//   the sentence lives in `dhPower.ts`. The panel rendered `DH_POWER_DESCRIPTION`; these assertions read it
//   through `byId(3)?.description`, which was a copy of it one hop away. Repointing them at the export is
//   strictly stronger -- the flow modal and the auction card read the same string, so this now guards every
//   surface that shows it rather than the one that has been removed.
//
//   THE HEX, because "accurate D&H execution mapping strictly to F16" is a deliverable and the coordinate
//   comes from a table the board can move under (`hexBoardData.ts` has relocated F16 once already).

import { DH_POWER_DESCRIPTION } from "../utils/dhPower";
import { privateHexFor } from "../utils/privateReservations";
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";

/* Design note #885: the two ids the hex powers belong to, named here rather than read from a table. They
   are `privatePowerOffer.ts`'s `PowerAbilityKey` union expressed as numbers, and that union is the thing
   that would have to grow for a third hex power to exist. */
const CSL_ID = 2;
const DH_ID = 3;

describe("the D&H caption", () => {
  /* Design note #885: WAS `byId(3)?.description`, the panel table's copy of this string. Now the export
     itself, which is what the panel was rendering all along -- see this file's header for why that makes
     the block stronger rather than merely surviving. */
  const caption = DH_POWER_DESCRIPTION;

  it("names F16 and the $120 terrain cost", () => {
    expect(caption).toContain("F16");
    expect(caption).toContain("$120");
  });

  it("says the TOKEN is the free half, not the tile", () => {
    // The old caption read "lay a tile AND place a station at no cost",
    // which is wrong in the direction that costs a player money: the
    // rulebook charges the mountain as usual and frees only the token.
    expect(caption).toContain("for $0");
    expect(caption).not.toMatch(/tile[^.]*at no cost/i);
  });

  it("presents the tile as takeable WITHOUT the token, but not the reverse", () => {
    /* Design note #725: THIS TEST USED TO ASSERT "AND/OR" AND WAS WRONG, which is the most useful thing in
       this file. #442 reasoned that "AND" alone "would deny a corporation the ordinary line of play where it
       takes the tile and skips the token" -- true, and it fixed that by making the two fully independent,
       which also permitted the line of play where a corporation takes the FREE TOKEN AND SKIPS THE TILE. That
       is not a line of play; it is the power's benefit without its cost.
       REPORTED: "the Place Station for free action ... should only be allowed if the track lay also happened".
       So the asymmetry is the rule, and a symmetric conjunction cannot state it. The green half of #442's
       concern survives -- tile-then-stop is still legal -- and it is now asserted as the ORDER rather than as
       a word. `dhPower.test.ts` holds the gate itself; this holds the sentence. */
    expect(caption).not.toMatch(/AND\/OR/i);
    expect(caption).toMatch(/only available with the lay/i);
    expect(caption).toMatch(/INSTEAD OF its normal tile lay/);
  });

  it("agrees with the catalog about which half is free", () => {
    /* ==============================================================
     *  DESIGN NOTE 548 (harness): PIN THE FACT, NOT THE SENTENCE
     * ==============================================================
     *
     * This asserted `toContain("laying the token is free")` -- the exact
     * clause, because the catalog then held the publisher's own wording and
     * a substring match was the cheapest way to prove the caption had not
     * drifted from it.
     *
     * That made the test a second copy of the copied text, and it failed
     * the moment the catalog was rewritten in this codebase's own words --
     * correctly, in the sense that something did change, and uselessly, in
     * the sense that nothing it was protecting was broken.
     *
     * What actually matters is the DISTINCTION, which is the thing an
     * earlier caption got wrong in the direction that costs a player money:
     * the mountain is charged as usual and only the token is free. Both
     * strings have to say that; neither has to say it the same way. */
    const ability = PRIVATE_COMPANY_CATALOG[3].ability;
    expect(ability).toContain("$120");
    expect(ability).toMatch(/token is free/i);
    // And the inverse must not be claimable -- the tile is never free.
    expect(ability).not.toMatch(/tile[^.]*(is free|at no cost|free of charge)/i);
  });

  it("no longer reproduces the publisher's phrasing", () => {
    /* Design note #548: the rewrite is a copyright measure, so a future
       pass that helpfully restores the "more accurate" original wording
       should fail here rather than ship. These three clauses are
       distinctive enough to be fingerprints and are not phrasings anyone
       would arrive at independently. */
    for (const id of [2, 3, 4, 5, 6]) {
      const ability = PRIVATE_COMPANY_CATALOG[id].ability;
      expect(ability).not.toMatch(/need not be connected to any track at all/i);
      expect(ability).not.toMatch(/without further payment/i);
      expect(ability).not.toMatch(/subject to the ordinary rules of the game/i);
    }
  });
});

describe("hex mapping", () => {
  it("maps the D&H strictly to F16", () => {
    const hex = privateHexFor(DH_ID);
    expect(hex).not.toBeNull();
    expect(hex!.hexLabel).toBe("F16");
  });

  it("maps the C&SL to B20", () => {
    expect(privateHexFor(CSL_ID)?.hexLabel).toBe("B20");
  });

  it("resolves both to real board coordinates", () => {
    for (const id of [CSL_ID, DH_ID]) {
      const hex = privateHexFor(id);
      expect(Number.isInteger(hex?.q)).toBe(true);
      expect(Number.isInteger(hex?.r)).toBe(true);
    }
  });

  it("returns null for the privates that hold no ground", () => {
    // Schuylkill Valley, Mohawk, Camden and the B&O grant shares or nothing
    // -- a coordinate for them would be an invented claim on a hex.
    for (const id of [1, 4, 5, 6]) {
      expect(privateHexFor(id)).toBeNull();
    }
  });

  it("gives both hex powers a coordinate to act on", () => {
    /* Design note #885: WAS "gives every corporation-scoped ability a hex to act on", walking
       `PRIVATE_ABILITIES` and filtering on `scope`. The table is gone; the property is not, and it is the
       same property stated over the two members that union has: a power routed to the map without a
       coordinate presses a button that goes nowhere.
       `privatePowerOffers` ENFORCES THIS AT RUN TIME -- "A CANDIDATE WITHOUT A HEX IS DROPPED, not rendered
       with a placeholder" -- so the failure it would produce today is a silently missing chip rather than a
       dead one. That is the better failure and still the wrong one. */
    for (const id of [CSL_ID, DH_ID]) {
      expect(privateHexFor(id)).not.toBeNull();
    }
  });
});


/* ==================================================================
 *  DESIGN NOTE 470 (harness): THE ROUND MUST MATCH
 * ==================================================================
 *
 * REPORTED: the Private Powers panel leaks into the Operating Round action
 * panel even when the acting corporation does not own the private.
 *
 * `ownsForScope` already refused a corporate power the acting corporation
 * did not own. The leak was the PLAYER-scoped exchanges: their phase is
 * StockRound, neither set `hideOutOfRound`, and the filter only hid an
 * ability when that flag was set -- so during an Operating Round they
 * rendered as disabled rows on a panel about a corporation that has nothing
 * to do with them.
 *
 * These are table-level assertions rather than render tests: the property
 * that must hold is "no ability is shown outside its own round", and that is
 * decided by `phase` plus the filter. A future power added with the wrong
 * phase is what these catch.
 */
