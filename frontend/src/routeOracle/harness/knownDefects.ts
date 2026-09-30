// frontend/src/routeOracle/harness/knownDefects.ts
//
// ==================================================================
//  ROUTE v12 R12-1: THE PREFLIGHT'S DEFECTS, PRESERVED AS FIXTURES
// ==================================================================
//
// TEST-ONLY. Each fixture is a small, VALID board (except ING-1, which is malformed on purpose and says so),
// the law's answer written by hand from the rulebook / the owner's rulings (`law`), and what production does
// today (`knownProduction`). The law is encoded as TOPOLOGY (which route is legal), and the dollar figures follow
// from it; they are asserted only because they are what the topology pays on this board.
//
// ROUTE v12 R12-2: THE KNOWN-RED RECORD IS REPAIRED. Every valid fixture's `knownProduction` now pins the law's
// answer -- "sound-optimal" at the law's optimum, the authority accepting that set and refusing each route the law
// forbids -- and `repairedFrom` keeps, verbatim, the defect class R12-1 pinned, so the repair is on the record and
// any regression fails the pin it would re-open. The law (`law`) is unchanged by R12-2. ING-1's malformed state
// keeps its own classification (see that fixture).

import type { BoardDefinition } from "../../components/hexBoardData";
import { STANDARD_BOARD } from "../../components/hexBoardData";
import { EXPANDED_BOARD, axialOf } from "../../components/hexBoardDataPlus";
import { LPF_BOARD } from "../../components/hexBoardDataLpf";
import type { TileColorTier } from "../../components/hexTileCatalog";
import type { CorpusBoard } from "./corpus";
import type { ProductionClass } from "./compare";

export interface KnownDefectFixture {
  id: string;
  title: string;
  board: CorpusBoard;
  companyId: number;
  fleet: readonly string[];
  law: {
    /** The legal optimum (hand-derived). */
    optimum: number;
    /** Routes the law forbids that production uses or accepts (waypoint text, `*` = bypass). */
    illegalRoutes: string[];
    /** A legal witness for the optimum: one waypoint route per train, in fleet order (`*` = bypass, `:n` = city).
     *  Asserted legal at exactly the optimum. */
    legalWitness: string[];
    /** Whether the state is outside the valid-state domain on purpose (ING-1). */
    malformed?: string;
  };
  knownProduction: {
    demonstrated: number;
    primary: ProductionClass;
    flags: ProductionClass[];
    /** The authority's verdict on production's set, as a pattern. */
    authority: RegExp;
  };
  /** R12-2: the KNOWN-RED production record R12-1 pinned (demonstrated figure, primary class, flags), kept for the
   *  record where R12-2 repaired it. Absent where production was already sound. */
  repairedFrom?: { demonstrated: number; primary: ProductionClass; flags: ProductionClass[] };
  /** Single routes put straight to the authority (train slot 0): what the law says, and what the authority
   *  answers today. Where they differ the AUTHORITY is defective, whatever the search does. */
  authorityProbes?: ReadonlyArray<{ route: string; law: "legal" | "illegal"; authorityToday: RegExp }>;
}

/** `"H10>H12*>H14"` -> waypoints (`*` = bypass, `:n` = city_node). */
export function parseRoute(text: string): Array<{ hex: string; bypass?: boolean; city_node?: number }> {
  return text.split(">").map((part) => {
    const bypass = part.includes("*");
    const [hex, city] = part.replace("*", "").split(":");
    return { hex, ...(bypass ? { bypass: true } : {}), ...(city !== undefined ? { city_node: Number(city) } : {}) };
  });
}

type Lay = [label: string, tileId: number, orientation: number];

export function fixtureBoard(
  id: string,
  board: BoardDefinition,
  variants: Record<string, unknown>,
  era: TileColorTier,
  lays: Lay[],
  companies: Array<{ companyId: number; tokens: Array<[label: string, city: number | null]>; licences?: number }>,
  synthetic = false,
): CorpusBoard {
  const at = (label: string) => {
    const hex = board.hexes.find((entry) => entry.label === label);
    if (!hex) throw new Error(`fixture ${id}: no hex ${label} on ${board.id}`);
    return { q: hex.q, r: hex.r };
  };
  const printed = board.hexes.flatMap((hex) =>
    hex.printedTile ? [{ q: hex.q, r: hex.r, tile_id: hex.printedTile.tileId, orientation: hex.printedTile.orientation, printed: true }] : [],
  );
  const laid = lays.map(([label, tile_id, orientation]) => ({ ...at(label), tile_id, orientation }));
  const tiles = new Map<string, CorpusBoard["lays"][number]>();
  [...printed, ...laid].forEach((tile) => tiles.set(`${tile.q},${tile.r}`, tile));
  return {
    id,
    source: "hand-built fixture (R12-1)",
    board,
    variants,
    era,
    lays: Array.from(tiles.values()),
    companies: companies.map((company) => ({
      companyId: company.companyId,
      tokens: company.tokens.map(([label, city]) => {
        const { q, r } = at(label);
        return city === null ? ([q, r] as const) : ([q, r, city] as const);
      }),
      licences: company.licences ?? 0,
    })),
    licenceNote: "fixture",
    ...(synthetic ? { synthetic: true as const } : {}),
  };
}

const PLUS = { expandedMap: true, plusTiles: true };
const LPF = { expandedMap: true, plusTiles: true, levelPlayingField: true };
const CO = 5;
const PRR = 1;
const NNH = 7;

export const KNOWN_DEFECT_FIXTURES: readonly KnownDefectFixture[] = [
  /* ---- 1. The same red area twice (rulebook 6.4.2's DABCFED example; brief section 1) ---- */
  {
    id: "RED-CANADIAN-WEST",
    title: "Canadian West (A9 + A11) may not be both ends of one route",
    // B10 (Barrie) green #14 turned 1: spokes 1 (A11), 2 (A9), 4, 5. C&O's station in Barrie.
    board: fixtureBoard("RED-CANADIAN-WEST", STANDARD_BOARD, {}, "Yellow", [["B10", 14, 1]], [{ companyId: CO, tokens: [["B10", 0]] }]),
    companyId: CO,
    fleet: ["3"],
    law: { optimum: 60, illegalRoutes: ["A9>B10>A11"], legalWitness: ["B10>A11"] },
    knownProduction: { demonstrated: 60, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$60$/ },
    repairedFrom: { demonstrated: 90, primary: "emits-illegal-optimum", flags: ["emits-illegal-optimum"] },
    authorityProbes: [{ route: "A9>B10>A11", law: "illegal", authorityToday: /counts Canadian West twice/ }],
  },
  {
    id: "RED-GULF",
    title: "the Gulf (I1 + J2) may not be both ends of one route",
    // I1 -(I3 #8 turned 1: edges 1 / 3)- H4 (Columbus, #15 turned 4: spokes 4, 5, 0, 1) -(I5 #8 turned 2: edges
    // 2 / 4)- J4 (#8 turned 1: edges 1 / 3) - J2. C&O's station in Columbus. Every tile is of its hex's class.
    board: fixtureBoard("RED-GULF", STANDARD_BOARD, {}, "Yellow", [["I3", 8, 1], ["H4", 15, 4], ["I5", 8, 2], ["J4", 8, 1]], [{ companyId: CO, tokens: [["H4", 0]] }]),
    companyId: CO,
    fleet: ["3"],
    law: { optimum: 60, illegalRoutes: ["I1>I3>H4>I5>J4>J2"], legalWitness: ["H4>I3>I1"] },
    knownProduction: { demonstrated: 60, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$60$/ },
    repairedFrom: { demonstrated: 90, primary: "emits-illegal-optimum", flags: ["emits-illegal-optimum"] },
    authorityProbes: [{ route: "I1>I3>H4>I5>J4>J2", law: "illegal", authorityToday: /counts Gulf twice/ }],
  },
  {
    id: "RED-GULF-TWO-TRAINS",
    title: "the Gulf's two halves by two trains is legal (two routes, one area each, sharing Columbus)",
    board: fixtureBoard("RED-GULF-TWO-TRAINS", STANDARD_BOARD, {}, "Yellow", [["I3", 8, 1], ["H4", 15, 4], ["I5", 8, 2], ["J4", 8, 1]], [{ companyId: CO, tokens: [["H4", 0]] }]),
    companyId: CO,
    fleet: ["2", "2"],
    law: { optimum: 120, illegalRoutes: [], legalWitness: ["H4>I3>I1", "H4>I5>J4>J2"] },
    knownProduction: { demonstrated: 120, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$120$/ },
  },
  {
    id: "RED-CHATTANOOGA",
    title: "Chattanooga (K1 + L2, 1830+) may not be both ends of one route",
    // K3 (Lexington) green #14 turned 3: spokes 3 (K1), 4 (L2), 0, 1. C&O's station in K3.
    board: fixtureBoard("RED-CHATTANOOGA", EXPANDED_BOARD, PLUS, "Yellow", [["K3", 14, 3]], [{ companyId: CO, tokens: [["K3", 0]] }]),
    companyId: CO,
    fleet: ["3"],
    law: { optimum: 60, illegalRoutes: ["K1>K3>L2"], legalWitness: ["K3>K1"] },
    knownProduction: { demonstrated: 60, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$60$/ },
    repairedFrom: { demonstrated: 90, primary: "emits-illegal-optimum", flags: ["emits-illegal-optimum"] },
    authorityProbes: [{ route: "K1>K3>L2", law: "illegal", authorityToday: /counts Chattanooga twice/ }],
  },

  /* ---- 2. The Altoona bypass (brief section 1): a hex traversed is not a station visited ---- */
  {
    id: "ALTOONA-BOW",
    title: "PRR's bare Altoona token does not count for a route that takes the bow past the city",
    // H10 (Pittsburgh) #57 (edges 0 / 3); Altoona (H12: city on 0-3, the bow 0-3); H14 #9 straight; H16
    // (Lancaster) #57. PRR's only station is its bare Altoona home.
    board: fixtureBoard("ALTOONA-BOW", STANDARD_BOARD, {}, "Yellow", [["H10", 57, 0], ["H14", 9, 0], ["H16", 57, 0]], [{ companyId: PRR, tokens: [["H12", null]] }]),
    companyId: PRR,
    fleet: ["2"],
    law: { optimum: 30, illegalRoutes: ["H10>H12*>H14>H16"], legalWitness: ["H12>H10"] },
    // The SEARCH found a legal $30 here all along; the defect was the AUTHORITY, which accepted the bow run ($20 +
    // $20, the city not visited, legal $40 -- above the demonstration, so the reducer applied it) because a bare
    // token "stood for the hex" before the bypass was checked. R12-2 (IL-7): a bare token counts only where the
    // route visits its stop.
    knownProduction: { demonstrated: 30, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$30$/ },
    authorityProbes: [
      { route: "H10>H12*>H14>H16", law: "illegal", authorityToday: /must pass through a city this corporation has a station token in/ },
      { route: "H12>H10", law: "legal", authorityToday: /^legal \$30$/ },
    ],
  },

  /* ---- 3. Re-entering a tile by a different section of track (brief section 1: CROSS_TWICE) ---- */
  {
    id: "CROSS-TWICE",
    title: "a crossover crossed twice by one route: legal, $40 -- beyond production's search until R12-2",
    board: fixtureBoard(
      "CROSS-TWICE",
      STANDARD_BOARD,
      {},
      "Yellow",
      [["I5", 57, 0], ["I7", 20, 0], ["I9", 7, 2], ["H8", 7, 4], ["J6", 57, 1]],
      [{ companyId: CO, tokens: [["I5", 0]] }],
      // `routeAuthority.test.ts`'s own CROSS_TWICE board, kept EXACTLY (brief section 1): city tiles on plain
      // hexes, so V10 is knowingly waived; the re-entry question does not depend on it.
      true,
    ),
    companyId: CO,
    fleet: ["2"],
    law: { optimum: 40, illegalRoutes: [], legalWitness: ["I5>I7>I9>H8>I7>J6"] },
    // R12-2 (IL-11): the search re-enters a plain hex on its other section of track.
    knownProduction: { demonstrated: 40, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$40$/ },
    repairedFrom: {
      demonstrated: 0,
      primary: "permits-skip-despite-legal-route",
      flags: ["fails-to-find-legal-route", "permits-skip-despite-legal-route"],
    },
  },

  /* ---- 4. The H12 herald fork (1830+ / LPF; brief section 2, S6-16) ---- */
  ...([
    ["HERALD-FORK-PLUS", EXPANDED_BOARD, PLUS],
    ["HERALD-FORK-LPF", LPF_BOARD, LPF],
  ] as const).map(([id, board, variants]): KnownDefectFixture => ({
    id,
    title: `the herald's Y (#24 at H12: stem 3, prongs 0 and 5) may not be run prong to prong (${board.id})`,
    // Prong 5 -> I13 #9 turned 2 (edges 2 / 5) -> J14 (Washington) #57 turned 2; prong 0 -> H14 #9 -> H16
    // (Reading / Lancaster) #57. The stem (H10) is left bare. PRR runs from its herald alone.
    board: fixtureBoard(id, board, variants, "Yellow", [["I13", 9, 2], ["J14", 57, 2], ["H14", 9, 0], ["H16", 57, 0]], [{ companyId: PRR, tokens: [] }]),
    companyId: PRR,
    fleet: ["3"],
    law: { optimum: 30, illegalRoutes: ["J14>I13>H12>H14>H16"], legalWitness: ["H12>H14>H16"] },
    // R12-2 (S6-16): the search joins two arms at H12 only where the rails join them.
    knownProduction: { demonstrated: 30, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$30$/ },
    repairedFrom: { demonstrated: 50, primary: "route-phase-stranding", flags: ["emits-illegal-optimum", "route-phase-stranding"] },
    authorityProbes: [
      { route: "J14>I13>H12>H14>H16", law: "illegal", authorityToday: /No rail through H12/ },
      { route: "H12>H14>H16", law: "legal", authorityToday: /^legal \$30$/ },
    ],
  })),

  /* ---- 5. Coal River without a licence (LPF; brief section 2) ---- */
  {
    id: "COAL-RIVER-UNLICENSED",
    title: "an unlicensed corporation may not touch L8 at all -- not even to end there",
    // K7 (Huntington) #57 turned 2: edges 2 / 5; 5 faces L8.
    board: fixtureBoard("COAL-RIVER-UNLICENSED", LPF_BOARD, LPF, "Yellow", [["K7", 57, 2]], [{ companyId: CO, tokens: [["K7", 0]], licences: 0 }]),
    companyId: CO,
    fleet: ["2"],
    law: { optimum: 0, illegalRoutes: ["K7>L8"], legalWitness: [] },
    // R12-2: nothing to demonstrate, and nothing demonstrated -- the skip is the corporation's to take.
    knownProduction: { demonstrated: 0, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^no set$/ },
    repairedFrom: { demonstrated: 60, primary: "route-phase-stranding", flags: ["emits-illegal-optimum", "route-phase-stranding"] },
    // Before R12-2 `evaluateRouteSet` alone accepted it (L8 walled as a "blocked city", and an end exempt) and only
    // the reducer's separate gate refused it -- a gate ingress never asked. The walk now refuses any touch of L8.
    authorityProbes: [{ route: "K7>L8", law: "illegal", authorityToday: /without a Kanawha Licence/ }],
  },
  {
    id: "COAL-RIVER-LICENSED",
    title: "a licensed corporation may end at L8 (a town, $40 until the first 5-train)",
    board: fixtureBoard("COAL-RIVER-LICENSED", LPF_BOARD, LPF, "Yellow", [["K7", 57, 2]], [{ companyId: CO, tokens: [["K7", 0]], licences: 1 }]),
    companyId: CO,
    fleet: ["2"],
    law: { optimum: 60, illegalRoutes: [], legalWitness: ["K7>L8"] },
    knownProduction: { demonstrated: 60, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$60$/ },
  },

  /* ---- 5b. LPF warehouses (brief section 3): pass-through towns, not red termini ---- */
  {
    id: "WAREHOUSE-M13-PASS",
    title: "the Deep South warehouse (M13) is run THROUGH to Coal River along M11's printed straight (licensed)",
    // K13 (Richmond) #57 turned 1 (edges 1 / 4; 4 faces L12); L12 #8 turned 5 (edges 5 / 1); M11 printed #9
    // (edges 0 / 3); M9 #8 (edges 0 / 2; 2 faces L8). C&O holds a licence.
    board: fixtureBoard(
      "WAREHOUSE-M13-PASS",
      LPF_BOARD,
      LPF,
      "Yellow",
      [["K13", 57, 1], ["L12", 8, 5], ["M9", 8, 0]],
      [{ companyId: CO, tokens: [["K13", 0]], licences: 1 }],
    ),
    companyId: CO,
    fleet: ["3"],
    law: { optimum: 90, illegalRoutes: [], legalWitness: ["K13>L12>M13>M11>M9>L8"] },
    knownProduction: { demonstrated: 90, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$90$/ },
  },
  {
    id: "WAREHOUSE-M13-UNLICENSED",
    title: "the same board without the licence: the warehouse ends the route; Coal River is closed",
    board: fixtureBoard(
      "WAREHOUSE-M13-UNLICENSED",
      LPF_BOARD,
      LPF,
      "Yellow",
      [["K13", 57, 1], ["L12", 8, 5], ["M9", 8, 0]],
      [{ companyId: CO, tokens: [["K13", 0]], licences: 0 }],
    ),
    companyId: CO,
    fleet: ["3"],
    law: { optimum: 50, illegalRoutes: ["K13>L12>M13>M11>M9>L8"], legalWitness: ["K13>L12>M13"] },
    knownProduction: { demonstrated: 50, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$50$/ },
    repairedFrom: { demonstrated: 90, primary: "route-phase-stranding", flags: ["emits-illegal-optimum", "route-phase-stranding"] },
  },
  {
    id: "WAREHOUSE-A11-LPF",
    title: "LPF Canadian West: A9 is a gray connector, A11 a warehouse two trains may share and one may run through",
    // B10 #14 turned 1 (edges 1 -> A11, 2 -> A9, 4, 5); B12 #8 (0 / 2); B14 #9 (0 / 3); B16 (Ottawa) #57.
    board: fixtureBoard(
      "WAREHOUSE-A11-LPF",
      LPF_BOARD,
      LPF,
      "Yellow",
      [["B10", 14, 1], ["B12", 8, 0], ["B14", 9, 0], ["B16", 57, 0]],
      [{ companyId: CO, tokens: [["B10", 0]] }],
    ),
    companyId: CO,
    fleet: ["3", "2"],
    law: { optimum: 140, illegalRoutes: ["B10>A11>A9>B10"], legalWitness: ["B10>A9>A11>B12>B14>B16", "B10>A11"] },
    knownProduction: { demonstrated: 140, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$140$/ },
  },
  {
    id: "CANADIAN-WEST-STANDARD",
    title: "the same layout on the standard board: A9 + A11 are one terminal red area -- no pass-through, never both ends",
    board: fixtureBoard(
      "CANADIAN-WEST-STANDARD",
      STANDARD_BOARD,
      {},
      "Yellow",
      [["B10", 14, 1], ["B12", 8, 0], ["B14", 9, 0], ["B16", 57, 0]],
      [{ companyId: CO, tokens: [["B10", 0]] }],
    ),
    companyId: CO,
    fleet: ["3", "2"],
    law: { optimum: 120, illegalRoutes: ["B10>A11>B12>B14>B16", "A9>B10>A11"], legalWitness: ["A9>B10", "B10>A11"] },
    knownProduction: { demonstrated: 120, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$120$/ },
    authorityProbes: [{ route: "A9>B10>A11", law: "illegal", authorityToday: /counts Canadian West twice/ }],
  },

  /* ---- 6. ING-1 (brief section 2): MALFORMED on purpose ---- */
  {
    id: "ING1-NYC-BARE-TOKEN",
    title: "NNH's token on New York recorded without a city (ING-1): a malformed state, and the join defect's other face",
    // G19 printed New York: city 0 on edge 1 (toward F20), city 1 on edge 4 (toward H18). F20 double town #55
    // (town 1 on edges 1 / 4; 4 faces G19); H18 green OO #59 turned 1 (city 0 on edge 1, facing G19).
    board: fixtureBoard("ING1-NYC-BARE-TOKEN", STANDARD_BOARD, {}, "Yellow", [["F20", 55, 0], ["H18", 59, 1]], [{ companyId: NNH, tokens: [["G19", null]] }]),
    companyId: NNH,
    fleet: ["3"],
    law: {
      optimum: 0,
      illegalRoutes: ["H18>G19>F20"],
      legalWitness: [],
      malformed: "V1: a token on a two-city hex must name its city; the oracle refuses the state as evidence",
    },
    /* R12-2: the JOIN through New York's two unconnected cities is gone (the search joins arms only where the rails
       do), so production no longer demonstrates the $90 the authority refused, and nothing is stranded: it runs
       G19's other city to H18 ($80), which the authority accepts on its own terms (a token recorded without a city
       stands for the hex -- #686), so the search and the authority agree. The oracle declines the malformed state
       (V1), so it calls every route illegal: that flag is the oracle's refusal of the STATE, not a production route
       defect. And the state can no longer be created: a paid placement on a two-city hex must name its city
       (`stationPlacementGate.ts`; the home placement always had to). */
    knownProduction: {
      demonstrated: 80,
      primary: "invalid-state",
      flags: ["invalid-state", "emits-illegal-optimum"],
      authority: /^legal \$80$/,
    },
    repairedFrom: { demonstrated: 90, primary: "invalid-state", flags: ["invalid-state", "route-phase-stranding", "emits-illegal-optimum"] },
  },
  {
    id: "ING1-NYC-CITY-RECORDED",
    title: "the same board with NNH's city recorded (city 0): valid, and production agrees -- repairing ING-1's data alone hides the join defect",
    board: fixtureBoard("ING1-NYC-CITY-RECORDED", STANDARD_BOARD, {}, "Yellow", [["F20", 55, 0], ["H18", 59, 1]], [{ companyId: NNH, tokens: [["G19", 0]] }]),
    companyId: NNH,
    fleet: ["3"],
    law: { optimum: 50, illegalRoutes: [], legalWitness: ["G19:0>F20"] },
    knownProduction: { demonstrated: 50, primary: "sound-optimal", flags: ["sound-optimal"], authority: /^legal \$50$/ },
  },
];

/** The twenty hexes that exist only on the 1830+ / LPF boards (brief section 2: J16 J18 K1-K17 L2-L16 M9-M13). */
export const VARIANT_ONLY_HEXES: readonly string[] = [
  "J16", "J18",
  "K1", "K3", "K5", "K7", "K9", "K11", "K17",
  "L2", "L4", "L6", "L8", "L10", "L12", "L14", "L16",
  "M9", "M11", "M13",
];

export { axialOf };
