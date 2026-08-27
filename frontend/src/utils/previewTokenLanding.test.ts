/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTES 885/886 (harness): THE GHOST AND THE DISPATCH AGREE
// ==================================================================
//
// REPORTED, of #878/#879's fix: "currently rotating through upgrade tiles on the ERIE home station hex is
// showing the correct/legal options, but the very first preview placement is jumping the station to the
// wrong city marker, even though all subsequent rotations place it correctly" -- and "on other OO hexes, the
// stations are previewing incorrectly and jumping around on rotations, not maintaining their corporation's
// network connectivity as they must."
//
// ONE OMISSION, TWO FACES. #879 taught the ROTATE path to derive a token's city from connectivity and left
// every other path on the old rule: selection seeded from #824's index-preserving choice, and the board
// applied the acting corporation's single index to every token on the hex.

import { tokenLandingsFor, type UpgradeTokenPlan } from "./tokenMigration";
import { errandLaysBonus } from "./bonusLay";

const plan = (
  landings: Array<{ companyId: number; toCityIndex: number | null }>,
): UpgradeTokenPlan => ({
  landings: landings.map((entry) => ({ ...entry, ticker: `C${entry.companyId}`, fromCityIndex: null })),
  anyFree: landings.some((entry) => entry.toCityIndex === null),
});

describe("every token's answer travels (design note #885)", () => {
  it("carries one entry per anchored token", () => {
    const result = tokenLandingsFor({
      plan: plan([
        { companyId: 1, toCityIndex: 0 },
        { companyId: 2, toCityIndex: 1 },
      ]),
      actingCompanyId: 1,
      chosenCity: undefined,
    });
    expect(result).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });

  it("lets the president's choice fill in their OWN free token", () => {
    /* ERIE'S CASE. The board never distinguished the two cities, so the rotation is the answer. */
    const result = tokenLandingsFor({
      plan: plan([{ companyId: 1, toCityIndex: null }]),
      actingCompanyId: 1,
      chosenCity: 1,
    });
    expect(result).toEqual([[1, 1]]);
  });

  it("ignores the choice for an ANCHORED token", () => {
    /* THE SIDE DOOR #878 CLOSED. Connectivity already decided; letting a rotation override it would put
       index-preservation back by another route. */
    const result = tokenLandingsFor({
      plan: plan([{ companyId: 1, toCityIndex: 0 }]),
      actingCompanyId: 1,
      chosenCity: 1,
    });
    expect(result).toEqual([[1, 0]]);
  });

  it("omits somebody else's free token rather than guessing", () => {
    /* THIS PRESIDENT IS NOT CHOOSING FOR THEM, and inventing an index would be #878's bug in a third hat.
       The reducer leaves an unnamed token where the chain recorded it. */
    const result = tokenLandingsFor({
      plan: plan([
        { companyId: 1, toCityIndex: 0 },
        { companyId: 2, toCityIndex: null },
      ]),
      actingCompanyId: 1,
      chosenCity: 1,
    });
    expect(result).toEqual([[1, 0]]);
  });

  it("says nothing when there is no plan", () => {
    expect(tokenLandingsFor({ plan: null, actingCompanyId: 1, chosenCity: 0 })).toEqual([]);
  });
});

describe("which lay is extra (design note #885)", () => {
  it("is the C&SL's and nobody else's", () => {
    /* #548: the two privates are exact opposites and the pair is easy to conflate. The D&H's lay CONSUMES
       the placement -- only its token is free -- so it must keep ending the Track step. */
    expect(errandLaysBonus({ kind: "private-tile", abilityKey: "csl-tile" })).toBe(true);
    expect(errandLaysBonus({ kind: "private-tile", abilityKey: "dh-tile" })).toBe(false);
  });

  it("is false for an ordinary lay", () => {
    expect(errandLaysBonus(null)).toBe(false);
    expect(errandLaysBonus({ kind: "private-station", abilityKey: "csl-tile" })).toBe(false);
  });

  it("is asked by the shell rather than restated there", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const APP = fs
      .readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(APP).toContain("const bonusLay = errandLaysBonus(homeStationPlacement);");
    expect(APP).not.toContain('abilityKey === "csl-tile"');
  });
});

describe("the preview derives once and everybody reads it (design note #886)", () => {
  const read = (rel: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs
      .readFileSync(path.join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  };
  const APP = read("App.tsx");
  const BOARD = read("components/HexGridRenderer.tsx");

  it("derives on SELECTION, not only on rotation", () => {
    /* FAULT (i). Selection seeded `tokenCity` from `tokenDestinationChoices(...)[0]` -- #824's rule, which
       consults neither connectivity nor orientation -- so the opening placement was the only one still using
       the superseded rule, and rotating "fixed" it. */
    const at = APP.indexOf("onSelectCandidate={(tileId, orientation) => {");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, at + 900);
    expect(body).toContain("derivePreviewLandings(");
    expect(body).not.toContain("tokenDestinationChoices(");
  });

  it("draws each company from the map, not from one index", () => {
    /* FAULT (ii), and it is #880's wire bug on the canvas: `previewTile.tokenCity` is ONE number and it was
       read inside a per-company loop, so a rival's marker was drawn in the acting corporation's city and
       moved with every rotation. */
    expect(BOARD).toContain("previewTile.tokenCities?.find(([id]) => id === company.company_id)?.[1]");
    const at = BOARD.indexOf("const previewCity =");
    const body = BOARD.slice(at, at + 300);
    expect(body).not.toContain("previewTile.tokenCity;");
  });

  it("sends exactly what the ghost drew", () => {
    /* A SECOND CALL IS A SECOND CHANCE TO DISAGREE. The lay recomputed the plan on the same inputs; it now
       reads the map the preview already holds. */
    expect(APP).toContain("const tokenCities = previewTile.tokenCities ?? [];");
  });

  it("keeps one derivation for every surface", () => {
    expect(APP).toContain("const derivePreviewLandings = useCallback(");
    /* FOUR CALL SITES SINCE #889, in two matching pairs -- selection and rotation each PROBE the candidate
       facing, then RECOMPUTE the map for the city that probe settled on. The pairing is the point: the probe
       is asked with the city the president currently holds, so its map can be one choice out of date.
       THE FIRST DRAFT SAID FOUR FOR A DIFFERENT REASON, counting the declaration -- which
       `derivePreviewLandings(` does not match. Second time this session (see #871's `runPrivateExchange`),
       which is why the named-site assertions above carry the real weight and this is only a guard against a
       fifth appearing unnoticed. */
    expect((APP.match(/derivePreviewLandings\(/g) ?? []).length).toBe(4);
    /* AND `planTokenUpgrade` HAS FOUR CALLERS, WHICH IS NOT THE SAME CLAIM. Two ask the LEGALITY question
       ("can this facing seat every token") -- `legalRotations`, and the facing search in
       `radialStationMarkersFor`. Two ask the DESTINATION question, and one of those is this callback. That
       the count is not three is a fact I got wrong by guessing before counting; it is written down here so
       the next person does not have to. A fifth would be a new path to a token's destination, which is how
       two surfaces come to disagree (#879). */
    expect((APP.match(/planTokenUpgrade\(/g) ?? []).length).toBe(4);
  });
});
