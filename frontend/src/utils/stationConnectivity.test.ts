/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 878 (harness): THE NETWORK IS THE ANCHOR
// ==================================================================
//
// REPORTED: "a station on a double city tile is not anchored to a particular city, it's anchored to its
// particular network ... In my current playthrough, upgrades to OO tiles are not preserving corporation
// station network connectivity."
//
// THE OLD RULE WAS `to = clamp(from)` -- city 0 in, city 0 out -- on a tile the player rotates freely, so the
// name "city 0" points at a different corner of the board at each of six orientations. The first block below
// is that bug expressed as arithmetic: same index, wrong network.

import { fitStationToUpgrade, fitStationsToUpgrade } from "./stationConnectivity";
import { tileCityEdges, tileCityCount } from "../components/hexGeometry";

describe("a token follows its edges, not its index", () => {
  it("moves to the city that kept its connection", () => {
    /* THE TOKEN RUNS EAST (edge 0). On the candidate, city 0 owns the west edges and city 1 owns the east --
       so preserving the network means moving to index 1. The old rule returned 0 and severed it. */
    const fit = fitStationToUpgrade([0], [[3, 4], [0, 1]]);
    expect(fit).toEqual({ kind: "anchored", cityIndex: 1 });
  });

  it("stays where it is when that city kept the connection", () => {
    // The common case, and the one that made index-preservation look correct for so long.
    expect(fitStationToUpgrade([3], [[3, 4], [0, 1]])).toEqual({ kind: "anchored", cityIndex: 0 });
  });

  it("keeps a token with two connections together", () => {
    /* BOTH EDGES OR NEITHER. A city that kept one of a token's two exits has still cut the network, and the
       containment test is what refuses the half-measure. */
    expect(fitStationToUpgrade([0, 1], [[0, 3], [0, 1]])).toEqual({ kind: "anchored", cityIndex: 1 });
  });

  it("allows the upgrade to ADD exits", () => {
    /* SUPERSET, NOT EQUALITY -- an upgrade normally gains track, which is the point of upgrading. Requiring
       an exact match would refuse every genuine improvement. */
    expect(fitStationToUpgrade([0], [[0, 1, 2], [3, 4]])).toEqual({ kind: "anchored", cityIndex: 0 });
  });
});

describe("an orientation that strands a token is not a legal upgrade", () => {
  it("refuses when no city keeps the connection", () => {
    /* THE HALF OF THE REPORT THAT IS A LEGALITY RULE: "the only legal upgrades are those that preserve the
       station marker with that connectivity to that specific hex." */
    expect(fitStationToUpgrade([2], [[0, 1], [3, 4]])).toEqual({ kind: "illegal" });
  });

  it("refuses a candidate that distinguishes no cities", () => {
    // Nothing to land in. Silence would be the caller quietly dropping the token.
    expect(fitStationToUpgrade([2], [])).toEqual({ kind: "illegal" });
  });

  it("fails the whole orientation when one token of several is stranded", () => {
    /* AN ORIENTATION IS LEGAL ONLY IF EVERY TOKEN SURVIVES IT, which is why the plural form returns one
       verdict rather than a list for the caller to reduce -- reducing it at each call site is how one of them
       comes to allow a lay the others refuse. */
    const anchors = [
      { companyId: 1, edges: [0] },
      { companyId: 2, edges: [2] },
    ];
    expect(fitStationsToUpgrade(anchors, [[0, 1], [3, 4]])).toBeNull();
  });

  it("passes when every token finds its city", () => {
    const anchors = [
      { companyId: 1, edges: [0] },
      { companyId: 2, edges: [3] },
    ];
    const landing = fitStationsToUpgrade(anchors, [[3, 4], [0, 1]]);
    expect(landing).not.toBeNull();
    expect(landing?.get(1)).toBe(1);
    expect(landing?.get(2)).toBe(0);
  });
});

describe("ERIE falls out of the rule rather than being named by it", () => {
  it("leaves an unconnected token free", () => {
    /* "ERIE is unusual because its home station can be placed on a city tile before that city has any track
       connecting it, and that is why upgrading the OO tile when ERIE's home station has already been laid
       requires allowing a player to rotate through all permutations."
       NO EDGES, NOTHING TO PRESERVE, EVERY CITY VACUOUSLY SATISFIES IT. No mention of ERIE anywhere in the
       module -- if another corporation ever lands a token on unconnected track, it gets the same freedom for
       the same reason. */
    expect(fitStationToUpgrade([], [[3, 4], [0, 1]])).toEqual({ kind: "free" });
  });

  it("never makes a free token illegal, whatever the candidate", () => {
    // Including a candidate with no cities at all: there is nothing to strand.
    expect(fitStationToUpgrade([], [])).toEqual({ kind: "free" });
  });

  it("records a free token as present with no derived city", () => {
    /* `null` INSIDE THE MAP, NOT `0`. "It survives and its destination is the president's" is a different
       fact from "it goes to city 0", and collapsing them is the original bug in miniature. */
    const landing = fitStationsToUpgrade([{ companyId: 7, edges: [] }], [[3], [0]]);
    expect(landing?.has(7)).toBe(true);
    expect(landing?.get(7)).toBeNull();
  });

  it("constrains the same token once it has track", () => {
    /* "and for the Brown OO upgrade to ERIE's home station hex, the stations have a preexisting network
       connectivity that MUST be preserved". Same corporation, same hex, later in the game -- and the rule
       treats it like everybody else because by then its edge set is not empty. */
    expect(fitStationToUpgrade([4], [[3, 4], [0, 1]])).toEqual({ kind: "anchored", cityIndex: 0 });
    expect(fitStationToUpgrade([4], [[0, 1], [2, 3]])).toEqual({ kind: "illegal" });
  });
});

describe("the real OO catalogue can answer the question", () => {
  /* THE RULE IS ONLY AS GOOD AS THE DATA IT READS. `cityScopeCoverage.test.ts` already pins that the eight
     double-city tiles carry two groups; this checks the other half -- that those groups rotate, so an
     orientation actually changes which board edges a city owns. Without that, every orientation would look
     identical to the rule above and it would allow all six. */
  const OO_TILES = [59, 64, 65, 66, 67, 68];

  it.each(OO_TILES)("tile %i distinguishes two cities", (tileId) => {
    expect(tileCityCount(tileId)).toBe(2);
  });

  it("rotates a city's edges with the tile", () => {
    const at0 = tileCityEdges(59, 0, 0);
    const at1 = tileCityEdges(59, 1, 0);
    expect(at0).not.toBeNull();
    expect(at1).not.toBeNull();
    expect(at1).toEqual((at0 ?? []).map((edge) => (edge + 1) % 6));
    // And the rotation is a real change rather than a fixed point.
    expect(at1).not.toEqual(at0);
  });

  it("keeps the two cities' edges disjoint", () => {
    /* THE PROPERTY THAT MAKES "AT MOST ONE CITY FITS" TRUE. If two cities shared an edge, a token on it could
       fit both and `findIndex` would silently prefer the lower index -- the old bug wearing a new hat. */
    OO_TILES.forEach((tileId) => {
      const a = new Set(tileCityEdges(tileId, 0, 0) ?? []);
      const b = tileCityEdges(tileId, 0, 1) ?? [];
      b.forEach((edge) => expect(a.has(edge)).toBe(false));
    });
  });

  it("says nothing about a tile with one city", () => {
    // `null`, so a caller reads "this tile does not distinguish cities" rather than "no edges".
    expect(tileCityEdges(8, 0, 0)).toBeNull();
    expect(tileCityCount(8)).toBe(0);
  });
});

describe("the shell asks the rule at all three surfaces (design note #879)", () => {
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

  it("drops rotations that strand a token", () => {
    /* THE LEGALITY HALF: "the only legal upgrades are those that preserve the station marker with that
       connectivity to that specific hex." The rotate gesture must not be able to reach an arrangement the
       rules forbid. */
    const at = APP.indexOf("const legalRotations");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("}, [radialCandidates", at));
    expect(body).toContain("planTokenUpgrade(");
    expect(body).toContain("!== null");
  });

  it("derives the city per facing instead of carrying it", () => {
    /* #824 CYCLED A CHOICE, which was right for ERIE and wrong as a general rule: for every other token the
       destination changes as the tile turns.
       RE-AIMED BY #886. This used to look for the inline expressions `mine?.toCityIndex != null` and
       `plan?.anyFree`; #886 folded the rotate path, the selection path and the confirm path into one
       `derivePreviewLandings`, so those literals are gone and the property moved to the derivation. The
       assertion follows it rather than being deleted -- and both arms of the split are named, because
       "anchored takes the derived city" is the half #824 got wrong and a call-only assertion would drop. */
    const at = APP.indexOf("const handlePreviewRotate");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("[radialSelector, handleDismissRadial", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("derivePreviewLandings(");
    /* #889 MOVED THE BRANCH INTO `previewRotation.ts`, so `probe.ownIsFree` / `probe.ownCity` are no longer
       written here. The shell's remaining obligation is to ASK about the candidate facing rather than the
       current one -- everything downstream of that is the module's arithmetic, walked in its own harness. */
    expect(body).toContain("fitAt: (orientation, chosenCity) =>");
    const RULE = read("utils/previewRotation.ts");
    expect(RULE).toContain("const fit = fitAt(facing.orientation, current.tokenCity);");
    expect(RULE).toContain("const tokenCity = fit.ownIsFree");
    expect(RULE).toContain("fit.ownCity;");
    /* AND THE ROTATION STORES THE WHOLE MAP, not just its own index -- this is the call site that feeds
       every OO token on the board through a rotation (#886, fault ii). */
    expect(body).toContain("tokenCities: landing.tokenCities,");
    /* THE DERIVATION IS WHERE FREE IS DEFINED, and it is defined per-company: this token has no network to
       preserve. `plan.anyFree` was a fact about the HEX and is the weaker question. */
    const dv = APP.indexOf("const derivePreviewLandings");
    expect(dv).toBeGreaterThan(-1);
    const derive = APP.slice(dv, APP.indexOf("[mapGrid, gameState, actingProtocolId]", dv));
    expect(derive).toContain("planTokenUpgrade(");
    expect(derive).toContain("ownIsFree: own !== null && own.toCityIndex === null,");
  });

  it("uses that one derivation everywhere a marker is placed", () => {
    /* #886'S FAULT IN ONE SENTENCE: "#879 taught the ROTATE path to derive a token's city from connectivity
       and left every other path on the old rule." Selecting a candidate seeded `tokenCity` from #824's
       superseded `tokenDestinationChoices(...)[0]`, so the FIRST preview of an upgrade put the marker in the
       wrong city and only a rotation corrected it.
       THREE CALL SITES, NOT TWO: selection, the rotate probe, and the rotate recompute for the chosen city.
       The count is asserted because a fourth path appearing without one is exactly how this recurred. */
    const calls = APP.match(/derivePreviewLandings\(\n/g) ?? [];
    expect(calls.length).toBe(3);
    /* ANCHORED ON THE JSX PROP, not on a `const` -- this handler is written inline on the ring. The strip
       above removes the comments, so #886's own note quoting `onSelectCandidate` cannot be what is found
       (#490a). */
    const sel = APP.indexOf("onSelectCandidate={");
    expect(sel).toBeGreaterThan(-1);
    const select = APP.slice(sel, APP.indexOf("legalRotationCount=", sel));
    expect(select.length).toBeGreaterThan(0);
    expect(select).toContain("derivePreviewLandings(");
    expect(select).not.toContain("tokenDestinationChoices(");
    /* THE OTHER HALF OF THE SAME FAULT: the FIRST preview must seed the whole map too, or an OO hex opens
       with every token stacked in the acting corporation's city and only looks right after a rotation. */
    expect(select).toContain("tokenCities: landing.tokenCities,");
  });

  it("passes the orientation to the thumbnails", () => {
    /* THE SIGNATURE IS THE TELL, and it was the tell for the old bug too: a destination that depends on the
       facing cannot be computed by a function with no facing in it. */
    const at = APP.indexOf("const radialStationMarkersFor");
    const body = APP.slice(at, at + 2000);
    expect(body).toContain("planTokenUpgrade(");
    expect(body).toContain("facing");
  });

  it("has retired the index-preserving preview from the shell", () => {
    /* NOT DELETED FROM THE MODULE -- its note is the record of the superseded rule -- but it has no caller
       here, and a second live path to a token's destination is how the two come to disagree. */
    expect(APP).not.toContain("previewTokenMigration(");
  });

  it("never draws SOMEBODY ELSE'S free token at a default city", () => {
    /* THE SUPERSEDED RULE'S LAST HIDING PLACE. A `null` destination rendered as `0` would put a marker in a
       city the board never chose.
       NARROWED BY #889, and the narrowing is the whole of the change. The thumbnail promises "the marker on
       the thumbnail is the marker they then see on the board", so once the preview seats the ACTING
       corporation's free token at the first city on offer, this surface has to seat it too or the promise is
       false. A RIVAL's free token still draws nothing: this president is not choosing for them, so there is
       no arrangement to promise -- as opposed to one they are about to be handed. */
    const at = APP.indexOf("const radialStationMarkersFor");
    expect(at).toBeGreaterThan(-1);
    const body = APP.slice(at, APP.indexOf("[radialSelector, mapGrid, gameState, radialCandidates", at));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain(
      "entry.toCityIndex ?? (entry.companyId === actingProtocolId ? seededCity : undefined)",
    );
    /* AND THE UNDECIDED ONES ARE DROPPED RATHER THAN COERCED. `cityIndex: undefined` reaching the canvas as
       `0` is the same bug through the type system instead of through an expression. */
    expect(body).toContain("marker.cityIndex !== undefined");
    /* THE SEED IS THE SAME RULE THE PREVIEW USES, not a second literal `0` that happens to agree today. */
    expect(body).toContain("freeCityChoices(tileCityCount(tileId))[0]");
  });
});

describe("the lay carries every token's destination (design note #880)", () => {
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
  const REDUCER = read("utils/sandboxSession.ts");
  const MIGRATION = read("utils/tokenMigration.ts");
  const BOARD = read("components/HexGridRenderer.tsx");

  it("sends one entry per token, not one index for the hex", () => {
    /* ASKED: "If a tile has multiple stations and a corporation upgrades it, it is necessary that all the
       stations maintain their connectivity, not just the one whose corporation is upgrading."
       `planTokenUpgrade` always computed all of them; the message could only carry one, so the rest were
       computed, drawn, and discarded.
       RE-AIMED BY #886. The map used to be assembled inline in the confirm handler, which was a SECOND call
       to the same derivation on the same inputs -- and a second call is a second chance to disagree with the
       ghost the player is looking at. The lay now sends what the preview already holds. */
    expect(APP).toContain("const tokenCities = previewTile.tokenCities ?? [];");
    expect(APP).toContain("token_cities: tokenCities");
    /* AND BOTH PREVIEW PATHS HAVE TO ACTUALLY CARRY THEM, or the line above sends an empty array on every
       lay -- which would be silent, because an absent map falls back to the legacy single index (#880).
       COUNTED, NOT MERELY CONTAINED, and the first draft of this assertion was the loose form. The string
       occurs twice -- once where a rotation lands and once where a candidate is first selected -- so a
       negative control deleting either one stayed GREEN behind the other. That is the bare-count vacuity
       trap wearing its opposite face: a bare `toContain` that survives a deletion. The two are also pinned
       to their own call sites in the tests above and below, so this count cannot be satisfied by two copies
       in one place. */
    expect(APP.match(/tokenCities: landing\.tokenCities,/g) ?? []).toHaveLength(2);
  });

  it("draws each company from that map, not from one index", () => {
    /* THE SAME FAULT ON THE CANVAS, reported as "on other OO hexes, the stations are previewing incorrectly
       and jumping around on rotations". The board read `previewTile.tokenCity` -- ONE index -- inside a loop
       over every company, so every token on an OO hex was drawn in the ACTING corporation's city and moved
       whenever the president rotated. #880 fixed the wire; this is the wire's other end. */
    expect(BOARD).toContain("previewTile.tokenCities?.find(([id]) => id === company.company_id)?.[1]");
  });

  it("lets the president's choice override only a FREE token", () => {
    /* ERIE'S CASE AND NOBODY ELSE'S. An anchored token ignores the rotation choice, because connectivity has
       already answered -- letting the choice win there would put the old bug back through a side door.
       ASSERTED IN THE RULE (#885) rather than at the call site: `tokenLandingsFor` is now the only place the
       override is written, and a call-site assertion would have gone green on an extraction that quietly
       dropped it. */
    expect(MIGRATION).toContain(
      "anchored === null && entry.companyId === actingCompanyId ? chosenCity : anchored;",
    );
    /* AND A FREE TOKEN BELONGING TO SOMEBODY ELSE IS OMITTED, not defaulted -- the board never said which
       city it is in and this president is not choosing for them. `0` would be #878's superseded rule in a
       third hat. */
    expect(MIGRATION).toContain("return chosen === undefined || chosen === null");
  });

  it("stops applying one index to every corporation on the hex", () => {
    /* THE OTHER HALF OF THE OLD REDUCER, and the one that would have stacked two tokens into one city. The
       map is consulted per company now. */
    const at = REDUCER.indexOf("const perCompany = new Map<number, number>");
    expect(at).toBeGreaterThan(-1);
    const body = REDUCER.slice(at, at + 900);
    expect(body).toContain("perCompany.has(company.company_id)");
    expect(body).toContain("perCompany.get(company.company_id)");
  });

  it("still replays a log written before the map existed", () => {
    /* "THE LOG IS THE GAME" (#522). An entry carrying only `token_city` has to land where it landed when it
       was written, which is why the old spelling is read rather than deleted -- and why it is read ONLY when
       the map is absent. */
    const at = REDUCER.indexOf("const perCompany = new Map<number, number>");
    const body = REDUCER.slice(at, at + 900);
    expect(body).toContain("perCompany.size === 0");
    expect(body).toContain("token_city");
  });

  it("leaves the board alone when the lay says nothing about tokens", () => {
    /* THE COMMON CASE -- an ordinary lay on empty cardboard -- must remain byte-identical to what this app
       has always sent, which is #808's containment argument applied a third time. */
    const at = REDUCER.indexOf("const perCompany = new Map<number, number>");
    const body = REDUCER.slice(at, at + 900);
    expect(body).toContain("if (perCompany.size === 0 && token_city === undefined) return state.public_companies;");
  });
});
