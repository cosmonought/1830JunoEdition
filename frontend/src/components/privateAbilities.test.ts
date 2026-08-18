// frontend/src/components/privateAbilities.test.ts
//
// ==================================================================
//  DESIGN NOTES 441/442/444 (harness): SCOPE, KEYS AND THE HEX
// ==================================================================
//
// Three facts about the ability table that the panel's behaviour depends on
// and that nothing else would catch:
//
//   SCOPE, because the reported bug -- the PRR President seeing the D&H --
//   was a single ability being filtered on the wrong ownership field. The
//   table now declares which test applies, and a new power added with the
//   wrong scope reintroduces the bug silently.
//
//   ACTION KEYS, because `usedAbilities` is keyed by them. Two abilities
//   sharing a key would make one power consume the other, which is exactly
//   the failure keying by `private_id` produced for the D&H's pair.
//
//   THE HEX, because "accurate D&H execution mapping strictly to F16" is a
//   deliverable, and the coordinate comes from a table the board can move
//   under (`hexBoardData.ts` has relocated F16 once already).

import { PRIVATE_ABILITIES } from "./PrivatePowerPanel";
import { privateHexFor } from "../utils/privateReservations";
import { PRIVATE_COMPANY_CATALOG } from "../utils/privateCatalog";

const byId = (id: number) => PRIVATE_ABILITIES.find((a) => a.privateId === id);

describe("ability scope", () => {
  it("gives the two hex powers CORPORATION scope", () => {
    // "A railroad owning the DH may lay a track tile and a station token."
    // The railroad, not the player holding the certificate -- which is the
    // reported bug in one word.
    expect(byId(2)?.scope).toBe("corporation"); // Champlain & St. Lawrence
    expect(byId(3)?.scope).toBe("corporation"); // Delaware & Hudson
  });

  it("gives the two share exchanges PLAYER scope", () => {
    // "A player owning the MH may exchange it for a 10% share of NYC."
    expect(byId(4)?.scope).toBe("player"); // Mohawk & Hudson
    expect(byId(5)?.scope).toBe("player"); // Camden & Amboy
  });

  it("declares a scope for every ability", () => {
    // A power added without one would fall to whichever branch the panel
    // checks first, which is how the original bug read as correct.
    for (const ability of PRIVATE_ABILITIES) {
      expect(["player", "corporation"]).toContain(ability.scope);
    }
  });

  it("no longer offers the B&O presidency", () => {
    // Design note #441: granted by `BoParPrompt` at the auction since design
    // note #399, so the button offered to do something already done.
    expect(byId(6)).toBeUndefined();
  });

  it("offers nothing for Schuylkill Valley, which has no power", () => {
    expect(byId(1)).toBeUndefined();
    expect(PRIVATE_COMPANY_CATALOG[1].ability).toMatch(/No special power/i);
  });
});

describe("action keys", () => {
  it("are unique across the whole table", () => {
    const keys = PRIVATE_ABILITIES.flatMap((a) => a.actions.map((x) => x.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives the D&H two independent actions", () => {
    // Both in one turn is legal 1830; one key for both would have made
    // either consume the other.
    const dh = byId(3);
    expect(dh?.actions.map((a) => a.key)).toEqual(["dh-tile", "dh-token"]);
  });

  it("labels the D&H buttons as the requirement words them", () => {
    const dh = byId(3);
    expect(dh?.actions.map((a) => a.label)).toEqual([
      "Lay Track (F16)",
      "Place Station Token for $0 (F16)",
    ]);
  });

  it("gives every other actionable ability exactly one action", () => {
    /* Design note #576: the Camden & Amboy now has ZERO. Its share arrives
       on purchase, so there is nothing for its owner to trigger -- the row
       keeps its description and loses its button.

       The exception is written as an explicit id rather than as
       `actions.length > 0`, because a self-satisfying assertion ("every
       ability with actions has actions") would pass for an ability that had
       silently lost its button too. Naming the two exceptions means a third
       one has to be argued for here. */
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.privateId === 3) continue; // D&H: two independent powers
      if (ability.privateId === 5) continue; // C&A: a purchase bonus, not an action
      expect(ability.actions).toHaveLength(1);
    }
  });

  it("leaves the Camden & Amboy describable but not clickable", () => {
    const ca = PRIVATE_ABILITIES.find((a) => a.privateId === 5);
    expect(ca).toBeDefined();
    expect(ca?.actions).toHaveLength(0);
    // The description still has to explain what the company did, or a player
    // finding a buttonless row concludes it has no power at all.
    expect(ca?.description).toMatch(/10%/);
    expect(ca?.description).toMatch(/PRR/);
  });
});

describe("the D&H caption", () => {
  const caption = byId(3)?.description ?? "";

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

  it("presents the two powers as separable", () => {
    // "AND" alone would deny a corporation the ordinary line of play where
    // it takes the tile and skips the token.
    expect(caption).toContain("AND/OR");
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
    const hex = privateHexFor(3);
    expect(hex).not.toBeNull();
    expect(hex!.hexLabel).toBe("F16");
  });

  it("maps the C&SL to B20", () => {
    expect(privateHexFor(2)?.hexLabel).toBe("B20");
  });

  it("resolves both to real board coordinates", () => {
    for (const id of [2, 3]) {
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

  it("gives every corporation-scoped ability a hex to act on", () => {
    // The panel routes these to the map; one without a coordinate would
    // press a button that goes nowhere -- the bug being fixed.
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.scope !== "corporation") continue;
      expect(privateHexFor(ability.privateId)).not.toBeNull();
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
describe("round scoping", () => {
  it("puts every hex power in the Operating Round", () => {
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.scope !== "corporation") continue;
      expect(ability.phase).toBe("OperatingRound");
    }
  });

  it("puts every share exchange in the Stock Round", () => {
    // These are what leaked. Their phase is what the filter now compares
    // against, so it has to be right.
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.scope !== "player") continue;
      expect(ability.phase).toBe("StockRound");
    }
  });

  it("gives every ability exactly one round", () => {
    for (const ability of PRIVATE_ABILITIES) {
      expect(["OperatingRound", "StockRound"]).toContain(ability.phase);
    }
  });

  it("has no ability that would render in both rounds", () => {
    // The filter is `roundType === ability.phase`, so a power can appear in
    // one round only. Asserted as a property of the table so a future
    // "either round" escape hatch has to be added deliberately.
    const byRound = new Map<string, number>();
    for (const ability of PRIVATE_ABILITIES) {
      byRound.set(ability.phase, (byRound.get(ability.phase) ?? 0) + 1);
    }
    expect(byRound.get("OperatingRound")).toBe(2); // C&SL, D&H
    expect(byRound.get("StockRound")).toBe(2); // M&H, C&A
  });
});
