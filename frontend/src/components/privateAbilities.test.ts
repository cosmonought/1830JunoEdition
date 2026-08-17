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

  it("gives every other ability exactly one action", () => {
    for (const ability of PRIVATE_ABILITIES) {
      if (ability.privateId === 3) continue;
      expect(ability.actions).toHaveLength(1);
    }
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

  it("agrees with the rulebook text the catalog quotes", () => {
    expect(PRIVATE_COMPANY_CATALOG[3].ability).toContain("$120");
    expect(PRIVATE_COMPANY_CATALOG[3].ability).toContain("laying the token is free");
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
