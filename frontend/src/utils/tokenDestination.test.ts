/** @jest-environment node */
//
// Which city a station marker lands in when the tile under it changes. No DOM.
//
// ==================================================================
//  DESIGN NOTE 824 (harness): THE INDEX WAS OURS, NOT THE BOARD'S
// ==================================================================
//
// REPORTED: "when players place a station on the preprinted yellow ERIE hex, they have no idea what the
// upgrade tile looks like or where their station will end up ... ERIE's president may lock themselves out of
// an orientation they want and either have to accept suboptimal placement or force the game to undo back
// into a previous Operating Round."
//
// AND THE ARGUMENT THAT SETTLED IT, which is not a house rule but the absence of one: "in an actual physical
// game, when a player upgrades ERIE's home hex, the station is removed from the board to place the new tile,
// then the player sets their token where they want it. Because there is no marking for 'City 1' vs 'City 2'
// on the preprinted yellow hex, there is no way to debate whether one city or the other is the correct one."
//
// `tokenMigration.ts` #1 HAD DECLARED THE OPPOSITE AND DEFENDED IT: "a token in city `i` stays in city `i`,
// which is the ordinary 18xx upgrade rule". True wherever `i` names something. On a LAID tile it does -- two
// circles, drawn in different places, a marker visibly in one. On the unlaid preprinted OO hex nothing
// distinguishes them; `tokenCityIndex` returns a number only because our storage needs one, and #1 then
// enforced that bookkeeping artefact as though the cardboard had said it.
//
// SO THIS IS THE WEEK'S RECURRING FAILURE IN ITS PUREST FORM: a surface asserting something the board never
// said. What makes it worth a harness of its own is that the assertion lived in a RULE MODULE with a design
// note defending it -- the hardest place to notice one, because everything downstream is entitled to trust it.
//
// #1's OTHER HALF WAS TRUE AND IS THE ACTUAL WORK: "a UI letting the president pick would collect an answer
// it cannot send." That is why this waited rather than being missed. It is fixed by carrying the answer.

import { previewTokenMigration, tokenDestinationChoices } from "./tokenMigration";
import { printedArtworkEdgePairs } from "../components/TileGraphics";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";
import { STATION_HOME_HEXES } from "../components/hexContractTypes";

/** ERIE's home: Dunkirk & Buffalo, a preprinted double city with no tile on it. */
const ERIE_HOME = STATION_HOME_HEXES.find((entry) => entry.companyId === 6)!;
/** New York, the other preprinted double city -- NNH's home under this board's house rule (#44). */
const NEW_YORK = STATION_HOME_HEXES.find((entry) => entry.companyId === 7)!;
/** Baltimore: a preprinted SINGLE city, so its one index is not a choice. */
const BALTIMORE = STATION_HOME_HEXES.find((entry) => entry.companyId === 4)!;

const BARE = { tiles: [] } as unknown as MapGridResponse;
const laidAt = (q: number, r: number, tileId: number) =>
  ({ tiles: [{ q, r, tile_id: tileId, orientation: 0, landmark: null }] }) as unknown as MapGridResponse;

const tokenOn = (hex: { q: number; r: number }, cityIndex = 0): StationTokenCompany =>
  ({
    company_id: 6,
    ticker: "ERIE",
    is_floated: true,
    station_token_hexes: [[hex.q, hex.r]],
    station_tokens: [[hex.q, hex.r, cityIndex]],
  }) as unknown as StationTokenCompany;

/** A green OO tile: two cities. #8 is a plain yellow with none, used as the single-city contrast. */
const GREEN_OO = 59;

describe("the board is what decides whether there is a choice", () => {
  it("offers both cities on an unlaid preprinted double city", () => {
    /* THE REPORTED CASE. Nothing on the cardboard tells ERIE's two cities apart, so the president picks --
       which is what lifting the marker off to lay the tile does in the physical game. */
    const choices = tokenDestinationChoices(BARE, ERIE_HOME.q, ERIE_HOME.r, [tokenOn(ERIE_HOME)], GREEN_OO);
    expect(choices).toEqual([0, 1]);
  });

  it("REGRESSION: does NOT offer New York the same choice", () => {
    /* ==================================================================
        DESIGN NOTE 824a: THIS ASSERTION USED TO EXPECT [0, 1]
       ==================================================================

       I generalised the rule to "unlaid preprinted double city" and wrote a test congratulating it for
       covering New York as well as ERIE. Corrected on report: "NY should not get the same treatment because
       the NNH home station is on a city with a route to it, and the connectivity of that station must be
       preserved. It would make no sense for NNH's station to be able to 'jump' to the disconnected city on
       its hex."

       THE BOARD SAYS SO AND I DID NOT ASK IT. `printedArtworkEdgePairs("G19")` is `[[1, null], [4, null]]` --
       two cities, one edge stub each -- against `[]` for E11, which prints no track at all. New York's cities
       are distinguished by what they connect to; ERIE's are two bare circles.

       WHICH MAKES THE REAL RULE CONNECTIVITY, and it was in the report all along: "a station can only be
       placed where there is route connectivity, and that connectivity must be preserved with every upgrade."
       Asserted here as the counterexample rather than deleted, because a harness that only shows the rule
       working shows nothing about where its edge is. */
    const token = { ...tokenOn(NEW_YORK), company_id: 7, ticker: "NNH" } as StationTokenCompany;
    expect(tokenDestinationChoices(BARE, NEW_YORK.q, NEW_YORK.r, [token], GREEN_OO)).toEqual([0]);
  });

  it("reads that distinction off the board rather than off a hex name", () => {
    /* THE PREMISE, read back -- the discipline #737 uses and the one I skipped when generalising. If G19 ever
       loses its stubs or E11 gains any, the rule flips for that hex and this fails first. */
    expect(printedArtworkEdgePairs("G19").length).toBeGreaterThan(0);
    expect(printedArtworkEdgePairs("E11")).toEqual([]);
  });

  it("offers no choice once a tile is down", () => {
    /* #1's rule, INTACT and now correctly scoped: a laid tile's circles are drawn in different places and the
       marker sits visibly in one of them, so preserving the index is a statement about the board. */
    const grid = laidAt(ERIE_HOME.q, ERIE_HOME.r, GREEN_OO);
    const choices = tokenDestinationChoices(grid, ERIE_HOME.q, ERIE_HOME.r, [tokenOn(ERIE_HOME, 1)], GREEN_OO);
    expect(choices).toEqual([1]);
  });

  it("offers no choice on a single city", () => {
    // One city is not a decision, which is every ordinary upgrade in the game.
    const choices = tokenDestinationChoices(BARE, BALTIMORE.q, BALTIMORE.r, [tokenOn(BALTIMORE)], GREEN_OO);
    expect(choices).toHaveLength(1);
  });

  it("says nothing where no token is standing", () => {
    /* THE COMMON CASE BY FAR, and the one that must cost nothing: an empty hex has no marker to place, so the
       rotate cycle gains no second dimension and every other lay on the board behaves exactly as before. */
    expect(tokenDestinationChoices(BARE, ERIE_HOME.q, ERIE_HOME.r, [], GREEN_OO)).toEqual([]);
  });

  it("counts the new tile's cities rather than assuming two", () => {
    /* A three-city tile would need no edit here. Asserted through `previewTokenMigration`, which is the
       function that knows -- so if the catalog ever grows one, this file already says what should happen. */
    const preview = previewTokenMigration(BARE, ERIE_HOME.q, ERIE_HOME.r, [tokenOn(ERIE_HOME)], GREEN_OO);
    expect(preview?.toCityCount).toBe(2);
    expect(tokenDestinationChoices(BARE, ERIE_HOME.q, ERIE_HOME.r, [tokenOn(ERIE_HOME)], GREEN_OO)).toHaveLength(
      preview!.toCityCount,
    );
  });
});

describe("the answer travels, because a choice the log drops is not a choice", () => {
  const read = (relative: string) => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  };
  const APP = read("App.tsx");
  const REDUCER = read("utils/sandboxSession.ts");
  const WIRE = read("utils/sessionKey.ts");

  it("adds the field #1 said did not exist", () => {
    /* #1: "a UI letting the president pick would collect an answer it cannot send and the contract would
       apply its own rule regardless -- the worst of the three outcomes, because the player would have been
       asked." Right, and the remedy is to make it sendable rather than to stop asking. */
    expect(WIRE).toContain("token_city?: number;");
    expect(WIRE).toContain("A FIELD THE CONTRACT DOES NOT HAVE YET");
  });

  it("omits it on every ordinary lay", () => {
    /* The containment #808's `bypass` has, for the same reason: a lay that never touches one of these two
       hexes must be byte-identical to what this app has always sent. */
    const dollar = String.fromCharCode(36);
    expect(APP).toContain("...(tokenCity !== undefined ? { token_city: tokenCity } : {})");
    expect(APP).not.toContain("token_city: " + dollar);
  });

  it("moves every token on the hex, not only the acting corporation's", () => {
    /* On an unlaid preprinted pair the cities are indistinguishable for whoever is standing there. In
       practice there is one occupant -- nobody else may token these hexes before they are upgraded -- but a
       rule that assumed that would be a rule about the board rather than about the cardboard. */
    expect(REDUCER).toContain("entry[0] === q && entry[1] === r");
    expect(REDUCER).toContain("token_city === undefined");
  });

  it("leaves the state untouched when the field is absent", () => {
    // `state.public_companies` by reference: the refusal idiom, and what keeps a replay of an old log identical.
    expect(REDUCER).toContain("? state.public_companies");
  });
});

describe("the rotate gesture carries the second dimension", () => {
  const APP = (() => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    return fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  })();

  it("advances the city only after the angles wrap", () => {
    /* REQUESTED: "let players click through every possible Green tile upgrade with the station marker on one
       city, then do it again on the other city." Orientation inner, city outer -- which is the order the
       question is asked in: can I get the facing I want, and then with the token where? */
    expect(APP).toContain("const wrapped = at + 1 >= legalRotations.length;");
    expect(APP).toContain("wrapped && cities.length > 1");
  });

  it("adds no control to learn", () => {
    // The rotate gesture already means "show me the next arrangement"; there are simply more arrangements.
    expect(APP).not.toContain("onSelectTokenCity");
  });

  it("draws the marker in the city being previewed", () => {
    const renderer = (() => {
      const fs = require("fs") as typeof import("fs");
      const path = require("path") as typeof import("path");
      return fs.readFileSync(
        path.join(__dirname, "..", "components", "HexGridRenderer.tsx"),
        "utf8",
      );
    })();
    expect(renderer).toContain("const chainCity = previewCity ?? tokenCityIndex(company, q, r);");
  });
});
