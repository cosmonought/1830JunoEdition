// Design notes #1320-#1322: the Level Playing Field variant -- state setup, entities and board.
//
// THE REQUEST IS THE ORACLE, as with the expansion (expandedBoard.test.ts, plusTiles.test.ts): every figure
// below is the request's own, and the standard and 18XX+ games are asserted unchanged before anything about
// the variant is.

import { STANDARD_BOARD, STATIC_BOARD_HEXES, activateBoard, isWarehouseHex } from "../components/hexBoardData";
import { EXPANDED_BOARD } from "../components/hexBoardDataPlus";
import {
  COAL_RIVER_EDGES,
  COAL_RIVER_LABEL,
  LPF_BOARD,
  LPF_WAREHOUSES,
  NW_COMPANY_ID,
  PMQ_COMPANY_ID,
} from "../components/hexBoardDataLpf";
import { STANDARD_TRAY, activateTray, trayInEffect } from "../components/tileTray";
import { PLUS_TRAY } from "../components/tileTrayPlus";
import { LPF_TRAY, LPF_TRAY_REMOVALS } from "../components/tileTrayLpf";
import { STATION_HOME_HEXES, stationHomeHexes } from "../components/hexContractTypes";
import {
  HEX_NEIGHBOR_OFFSETS,
  archetypeForHex,
  evaluateHexForTileLaying,
  hexValueForEra,
  liveEdgesForHex,
} from "../components/hexGeometry";
import { printedArtwork, printedTraversalVariants } from "../components/TileGraphics";
import type { MapGridResponse } from "../components/hexContractTypes";
import { STANDARD_VARIANTS, hasAnyVariant, resolveVariants } from "./gameVariants";
import {
  LPF_CERT_LIMIT_BY_PLAYER_COUNT,
  LPF_MAX_PLAYERS,
  MAX_PLAYERS,
  certLimitForPlayers,
  dealSandboxGame,
  isLegalPlayerCount,
  maxPlayersFor,
  startingCashForPlayers,
  waterfallForRoster,
  type SetupPlayer,
} from "./gameSetup";
import { boardFor, trayFor, withRules } from "./boardSelection";
import { isOffboardTerminal, traversalsFrom } from "./trackSegments";
import { isRevenueCentreHex, isRouteTerminusHex, applySandboxAction } from "./sandboxSession";
import { sandboxGameState, sandboxWaterfallState } from "./sandboxState";
import { stationTokenPrice, stationTokenSlots } from "./stationTokens";
import { JK_PRIVATE_ID, withLevelPlayingFieldPrivates } from "./levelPlayingField";
import { PRIVATE_COMPANY_CATALOG } from "./privateCatalog";
import { corporationLiveryColor, CORPORATION_LIVERY_COLORS } from "../styles/corporationLivery";
import { corporationFullName, corporationDisplayRank } from "./corporationNames";
import { logoSrcFor } from "../components/CorporateLogo";

const LPF = resolveVariants({ levelPlayingField: true });
const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const BARE: MapGridResponse = { game_id: 1, tiles: [] };

function hexByLabel(label: string) {
  const found = STATIC_BOARD_HEXES.find((hex) => hex.label === label);
  if (!found) throw new Error(`${label} is not on the board in effect`);
  return found;
}

function seats(count: number): SetupPlayer[] {
  return Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `P${index}` }));
}

afterEach(() => {
  activateBoard(STANDARD_BOARD);
  activateTray(STANDARD_TRAY);
});

/* ------------------------------------------------------------------ */
/* 1. Variant setup and player counts                                  */
/* ------------------------------------------------------------------ */

describe("the variant flag (design note #1320)", () => {
  it("is off in the standard game and reads absent as off", () => {
    expect(STANDARD_VARIANTS.levelPlayingField).toBe(false);
    expect(resolveVariants({}).levelPlayingField).toBe(false);
    expect(resolveVariants({ expandedMap: true, plusTiles: true }).levelPlayingField).toBe(false);
  });

  it("forces the expanded map and the plus tile set on", () => {
    expect(LPF.expandedMap).toBe(true);
    expect(LPF.plusTiles).toBe(true);
    // Even when the log explicitly recorded them off: the variant cannot exist without them.
    const forced = resolveVariants({ levelPlayingField: true, expandedMap: false, plusTiles: false });
    expect(forced.expandedMap).toBe(true);
    expect(forced.plusTiles).toBe(true);
  });

  it("counts as a house rule and selects its own board and tray", () => {
    expect(hasAnyVariant({ ...STANDARD_VARIANTS, levelPlayingField: true })).toBe(true);
    expect(boardFor(LPF)).toBe(LPF_BOARD);
    expect(trayFor(LPF)).toBe(LPF_TRAY);
    expect(boardFor(PLUS)).toBe(EXPANDED_BOARD);
    expect(trayFor(PLUS)).toBe(PLUS_TRAY);
    withRules(LPF, () => expect(trayInEffect()).toBe(LPF_TRAY));
  });
});

describe("player counts, cash and certificate limits (design note #1320)", () => {
  it("seats seven under the variant and six otherwise", () => {
    expect(MAX_PLAYERS).toBe(6);
    expect(LPF_MAX_PLAYERS).toBe(7);
    expect(maxPlayersFor(STANDARD_VARIANTS)).toBe(6);
    expect(maxPlayersFor(LPF)).toBe(7);
    expect(isLegalPlayerCount(7)).toBe(false);
    expect(isLegalPlayerCount(7, LPF)).toBe(true);
    expect(isLegalPlayerCount(8, LPF)).toBe(false);
    expect(isLegalPlayerCount(2, LPF)).toBe(true);
  });

  it("uses the request's certificate limits: 32 / 22 / 18 / 15 / 13 / 12", () => {
    expect(LPF_CERT_LIMIT_BY_PLAYER_COUNT).toEqual({ 2: 32, 3: 22, 4: 18, 5: 15, 6: 13, 7: 12 });
    for (const [count, limit] of Object.entries(LPF_CERT_LIMIT_BY_PLAYER_COUNT)) {
      expect(certLimitForPlayers(Number(count), LPF)).toBe(limit);
    }
    // The printed table is untouched.
    expect(certLimitForPlayers(4)).toBe(16);
    expect(certLimitForPlayers(4, STANDARD_VARIANTS)).toBe(16);
    expect(certLimitForPlayers(7)).toBeNull();
  });

  it("deals $360 to each of seven, and the printed figures to fewer", () => {
    expect(startingCashForPlayers(7, LPF)).toBe(360);
    expect(startingCashForPlayers(7)).toBeNull();
    expect(startingCashForPlayers(4, LPF)).toBe(600);
    const dealt = dealSandboxGame({ players: seats(7), variants: { levelPlayingField: true } });
    expect(dealt).not.toBeNull();
    expect(dealt?.startingCash).toBe(360);
    expect(dealt?.certLimit).toBe(12);
    expect(dealt?.bankRemaining).toBe(12000 - 7 * 360);
    expect(dealt?.variants.plusTiles).toBe(true);
    // Seven without the variant is refused, not approximated.
    expect(dealSandboxGame({ players: seats(7), variants: {} })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Tile tray                                                           */
/* ------------------------------------------------------------------ */

describe("the tray (design note #1320)", () => {
  it("is the 18XX+ tray minus #5 (2), #6 (2), #592 (2) and #61 (2)", () => {
    expect(LPF_TRAY_REMOVALS).toEqual([
      [5, 2],
      [6, 2],
      [592, 2],
      [61, 2],
    ]);
    for (const [tileId, removed] of LPF_TRAY_REMOVALS) {
      const before = PLUS_TRAY.counts.get(tileId) ?? 0;
      const after = LPF_TRAY.counts.get(tileId) ?? 0;
      expect(before - after).toBe(Math.min(before, removed));
    }
    // Each of the four is removed outright, because the 18XX+ tray held exactly two of each.
    for (const [tileId] of LPF_TRAY_REMOVALS) expect(LPF_TRAY.counts.has(tileId)).toBe(false);
    // Everything else is what it was.
    for (const [tileId, count] of Array.from(PLUS_TRAY.counts.entries())) {
      if (LPF_TRAY_REMOVALS.some(([removedId]) => removedId === tileId)) continue;
      expect(LPF_TRAY.counts.get(tileId)).toBe(count);
    }
    // #810 and #882 are deliberately not coded (not in the catalog).
    expect(LPF_TRAY_REMOVALS.some(([id]) => id === 810 || id === 882)).toBe(false);
    // The 18XX+ tray is untouched.
    expect(PLUS_TRAY.counts.get(5)).toBe(2);
    expect(PLUS_TRAY.counts.get(61)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The warehouses                                                   */
/* ------------------------------------------------------------------ */

describe("the warehouses (design note #1321)", () => {
  const STUB_COUNTS: Record<string, number> = { M13: 3, L2: 3, F2: 3, A11: 3, B24: 2 };

  it("are the five named red areas, with the requested stub counts, and nowhere else", () => {
    expect(Object.keys(LPF_WAREHOUSES).sort()).toEqual(Object.keys(STUB_COUNTS).sort());
    for (const [label, count] of Object.entries(STUB_COUNTS)) {
      expect(LPF_WAREHOUSES[label]).toHaveLength(count);
      expect(new Set(LPF_WAREHOUSES[label]).size).toBe(count);
    }
    withRules(LPF, () => {
      for (const label of Object.keys(STUB_COUNTS)) {
        const hex = hexByLabel(label);
        expect(hex.type).toBe("RedOffboard");
        expect(hex.warehouse).toBe(true);
        expect(isWarehouseHex(label)).toBe(true);
        expect(liveEdgesForHex(BARE, hex.q, hex.r).sort()).toEqual([...LPF_WAREHOUSES[label]].sort());
      }
      expect(isWarehouseHex("K3")).toBe(false);
    });
    // Neither of the other boards has any.
    withRules(PLUS, () => expect(STATIC_BOARD_HEXES.some((hex) => hex.warehouse)).toBe(false));
    expect(STATIC_BOARD_HEXES.some((hex) => hex.warehouse)).toBe(false);
    expect(isWarehouseHex("M13")).toBe(false);
  });

  it("keep their names and printed values", () => {
    withRules(LPF, () => {
      for (const label of Object.keys(STUB_COUNTS)) {
        expect(LPF_BOARD.offboardLabels[label]).toBe(EXPANDED_BOARD.offboardLabels[label]);
        const hex = hexByLabel(label);
        const name = EXPANDED_BOARD.offboardLabels[label];
        const tiers = EXPANDED_BOARD.offboardRevenue[name];
        expect(hexValueForEra(BARE, hex.q, hex.r, "Yellow")).toBe(tiers.yellow);
        expect(hexValueForEra(BARE, hex.q, hex.r, "Brown")).toBe(tiers.brown);
      }
    });
  });

  it("are stops a route may pass through OR end at, and never token (design note #1286)", () => {
    /* #1321 read them as small towns -- "never a terminus". RULED OTHERWISE: "unlike small towns the
       warehouses are also valid termini for routes". Passing through is still legal (`isOffboardTerminal`
       is false), ending is legal now, and the slot count (a `town` marker in `GRAY_HEXES`) is still zero. */
    withRules(LPF, () => {
      for (const [label, edges] of Object.entries(LPF_WAREHOUSES)) {
        const hex = hexByLabel(label);
        expect(archetypeForHex(BARE, hex.q, hex.r)).toBe("SingleTown");
        expect(isRevenueCentreHex(BARE, label)).toBe(true);
        expect(isRouteTerminusHex(BARE, label)).toBe(true);
        expect(isOffboardTerminal(hex.q, hex.r)).toBe(false);
        // Every stub meets every other at the centre.
        for (const entry of edges) {
          const exits = traversalsFrom(BARE, hex.q, hex.r, entry).map((t) => t.exitEdge).sort();
          expect(exits).toEqual(edges.filter((e) => e !== entry).sort());
          for (const exit of edges) {
            if (exit === entry) continue;
            expect(printedTraversalVariants(label, entry, exit).length).toBeGreaterThan(0);
          }
        }
        // Still unbuildable.
        expect(evaluateHexForTileLaying(hex.q, hex.r, BARE).reason).toBe("offboard");
        // Design note #1286: drawn as spokes to a CITY circle holding a crate -- a stop that reads as one.
        const art = printedArtwork(label);
        expect(art?.marker?.kind).toBe("city");
        expect(art?.emblem).toEqual({ kind: "crate" });
        expect(art?.tracks).toHaveLength(edges.length);
      }
    });
    // On the expansion the same hexes are still terminals.
    withRules(PLUS, () => {
      const m13 = hexByLabel("M13");
      expect(isOffboardTerminal(m13.q, m13.r)).toBe(true);
      expect(isRouteTerminusHex(BARE, "M13")).toBe(true);
      expect(archetypeForHex(BARE, m13.q, m13.r)).toBe("Plain");
    });
  });

  it("turn the region partners K1 and A9 into gray connectors into the warehouse", () => {
    withRules(LPF, () => {
      const k1 = hexByLabel("K1");
      const a9 = hexByLabel("A9");
      for (const hex of [k1, a9]) {
        expect(hex.type).toBe("Plain");
        expect(hex.printedColor).toBe("Gray");
        expect(LPF_BOARD.offboardLabels[hex.label]).toBeUndefined();
        expect(LPF_BOARD.offboardHiddenEdges[hex.label]).toBeUndefined();
        expect(archetypeForHex(BARE, hex.q, hex.r)).toBe("Plain");
        expect(evaluateHexForTileLaying(hex.q, hex.r, BARE).reason).toBe("gray-immutable");
      }
      // K1: NE (J2) to SE (L2). A9: SE (B10) to E (A11).
      expect(liveEdgesForHex(BARE, k1.q, k1.r).sort()).toEqual([1, 5]);
      expect(liveEdgesForHex(BARE, a9.q, a9.r).sort()).toEqual([0, 5]);
      expect(traversalsFrom(BARE, k1.q, k1.r, 1).map((t) => t.exitEdge)).toEqual([5]);
      expect(traversalsFrom(BARE, a9.q, a9.r, 5).map((t) => t.exitEdge)).toEqual([0]);
      // The warehouse's new stub faces the partner: L2's NW is K1, A11's W is A9.
      const l2 = hexByLabel("L2");
      const a11 = hexByLabel("A11");
      const [dqK, drK] = HEX_NEIGHBOR_OFFSETS[2];
      expect({ q: l2.q + dqK, r: l2.r + drK }).toEqual({ q: k1.q, r: k1.r });
      const [dqA, drA] = HEX_NEIGHBOR_OFFSETS[3];
      expect({ q: a11.q + dqA, r: a11.r + drA }).toEqual({ q: a9.q, r: a9.r });
      // No two-hex regions remain.
      expect(LPF_BOARD.offboardHiddenEdges.L2).toBeUndefined();
      expect(LPF_BOARD.offboardHiddenEdges.A11).toBeUndefined();
    });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Coal River                                                       */
/* ------------------------------------------------------------------ */

describe("Coal River, L8 (design note #1321)", () => {
  it("is a fixed printed hex of its own colour that is a small town", () => {
    withRules(LPF, () => {
      const l8 = hexByLabel(COAL_RIVER_LABEL);
      expect(l8.printedColor).toBe("Coal");
      expect(archetypeForHex(BARE, l8.q, l8.r)).toBe("SingleTown");
      expect(isRevenueCentreHex(BARE, COAL_RIVER_LABEL)).toBe(true);
      expect(isRouteTerminusHex(BARE, COAL_RIVER_LABEL)).toBe(false);
      expect(evaluateHexForTileLaying(l8.q, l8.r, BARE).eligible).toBe(false);
      // Design note #1282: the nameplate says "Coalfields"; Coal River stays the code name.
      expect(LPF_BOARD.namedHexLabels[COAL_RIVER_LABEL]).toBe("Coalfields");
    });
  });

  it("connects its five inward edges at the centre", () => {
    expect(COAL_RIVER_EDGES).toHaveLength(5);
    expect(COAL_RIVER_EDGES).toContain(5); // SE, into M9
    withRules(LPF, () => {
      const l8 = hexByLabel(COAL_RIVER_LABEL);
      expect(liveEdgesForHex(BARE, l8.q, l8.r).sort()).toEqual([...COAL_RIVER_EDGES].sort());
      // Every edge points at a real hex.
      for (const edge of COAL_RIVER_EDGES) {
        const [dq, dr] = HEX_NEIGHBOR_OFFSETS[edge];
        expect(STATIC_BOARD_HEXES.some((hex) => hex.q === l8.q + dq && hex.r === l8.r + dr)).toBe(true);
      }
      for (const entry of COAL_RIVER_EDGES) {
        const exits = traversalsFrom(BARE, l8.q, l8.r, entry).map((t) => t.exitEdge).sort();
        expect(exits).toEqual(COAL_RIVER_EDGES.filter((e) => e !== entry).sort());
      }
      const art = printedArtwork(COAL_RIVER_LABEL);
      expect(art?.marker?.kind).toBe("town");
      // Design note #1282: the "$120" box is gone; the pickaxe alone marks the hex.
      expect(art?.emblem).toEqual({ kind: "coal" });
    });
  });

  it("pays $40 through Green and $60 from Brown", () => {
    withRules(LPF, () => {
      const l8 = hexByLabel(COAL_RIVER_LABEL);
      expect(hexValueForEra(BARE, l8.q, l8.r, "Yellow")).toBe(40);
      expect(hexValueForEra(BARE, l8.q, l8.r, "Green")).toBe(40);
      expect(hexValueForEra(BARE, l8.q, l8.r, "Brown")).toBe(60);
      expect(hexValueForEra(BARE, l8.q, l8.r, "Gray")).toBe(60);
    });
    // On the expansion L8 is still a plain mountain.
    withRules(PLUS, () => {
      const l8 = hexByLabel(COAL_RIVER_LABEL);
      expect(l8.type).toBe("Mountain");
      expect(hexValueForEra(BARE, l8.q, l8.r, "Brown")).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 4. New entities and token rules                                     */
/* ------------------------------------------------------------------ */

describe("the new corporations (design note #1322)", () => {
  it("home at E5 (PMQ) and L16 (N&W), on this board only", () => {
    expect(STATION_HOME_HEXES).toHaveLength(8);
    expect(stationHomeHexes()).toHaveLength(8);
    withRules(PLUS, () => expect(stationHomeHexes()).toHaveLength(8));
    withRules(LPF, () => {
      const homes = stationHomeHexes();
      // The printed eight, PMQ, N&W -- and C&O's second home at Richmond (#1325).
      expect(homes).toHaveLength(11);
      const pmq = homes.find((home) => home.companyId === PMQ_COMPANY_ID);
      const nw = homes.find((home) => home.companyId === NW_COMPANY_ID);
      expect(pmq?.label).toBe("E5");
      expect(nw?.label).toBe("L16");
      // Coordinates agree with the board's own hexes.
      expect(hexByLabel("E5")).toMatchObject({ q: pmq?.q, r: pmq?.r });
      expect(hexByLabel("L16")).toMatchObject({ q: nw?.q, r: nw?.r });
      // E5 is an OO hex, as ERIE's E11 is.
      expect(LPF_BOARD.yellowOoHexes.has("E5")).toBe(true);
      expect(LPF_BOARD.yellowOoHexes.has("E11")).toBe(true);
    });
  });

  it("have a livery, a full name, a card order and a logo", () => {
    expect(CORPORATION_LIVERY_COLORS[PMQ_COMPANY_ID]).toBe("#6b2fa0");
    expect(corporationLiveryColor(NW_COMPANY_ID)).not.toBe(corporationLiveryColor(999));
    expect(corporationFullName("PMQ")).toBe("Pere Marquette");
    expect(corporationFullName("N&W")).toBe("Norfolk & Western");
    expect(corporationDisplayRank("PMQ")).toBeLessThan(corporationDisplayRank("PRR"));
    expect(corporationDisplayRank("N&W")).toBeLessThan(corporationDisplayRank("NYC"));
    expect(logoSrcFor("PMQ")).toBe("/Logos/PMQ.jpeg");
    expect(logoSrcFor("N&W")).toBe("/Logos/N%26W.webp");
  });

  it("join the roster on the deal, with the JK between the M&H and the C&A", () => {
    const base = sandboxGameState("WaterfallAuction", 1);
    // `applySandboxAction` puts the deal's own board in effect (#1300); a `SetupGame` is a `SandboxLogMsg`.
    const dealt = applySandboxAction(base, {
      SetupGame: { players: seats(7), variants: { levelPlayingField: true } },
    } as never);
    expect(dealt.player_addresses).toHaveLength(7);
    expect(dealt.player_cash.every((row) => row.cash_vgp === "360")).toBe(true);

    const tickers = dealt.public_companies.map((company) => company.ticker);
    expect(tickers).toHaveLength(10);
    expect(tickers).toContain("PMQ");
    expect(tickers).toContain("N&W");
    const pmq = dealt.public_companies.find((company) => company.ticker === "PMQ");
    const nw = dealt.public_companies.find((company) => company.ticker === "N&W");
    expect(pmq).toMatchObject({
      company_id: PMQ_COMPANY_ID,
      home_hex_label: "E5",
      station_token_limit: 2,
      is_floated: false,
      president: null,
      par_value: null,
      ipo_pool_percentage: 100,
    });
    expect(nw).toMatchObject({ company_id: NW_COMPANY_ID, home_hex_label: "L16", station_token_limit: 3 });

    const privates = dealt.private_companies;
    expect(privates).toHaveLength(7);
    const costs = privates.map((entry) => Number(entry.cost));
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
    const jkAt = privates.findIndex((entry) => entry.private_id === JK_PRIVATE_ID);
    expect(privates[jkAt]).toMatchObject({ name: "James River & Kanawha Company", cost: "120", revenue_per_or: "20", owner: null });
    expect(privates[jkAt - 1].name).toBe("Mohawk & Hudson");
    expect(privates[jkAt + 1].name).toBe("Camden & Amboy");
    // Idempotent: a second application adds nothing.
    expect(withLevelPlayingFieldPrivates(privates)).toHaveLength(7);

    // The auction offers what the deal holds.
    const waterfall = waterfallForRoster(
      sandboxWaterfallState("WaterfallAuction", 1, true),
      dealt.player_addresses,
      dealt.private_companies,
    );
    expect(waterfall?.privates.map((entry) => entry.private_id)).toEqual(privates.map((entry) => entry.private_id));
    expect(waterfall?.privates[0].is_lowest_offered).toBe(true);
    expect(waterfall?.privates.filter((entry) => entry.is_lowest_offered)).toHaveLength(1);
    expect(waterfall?.privates[jkAt].face_value).toBe("120");

    // The catalog knows it.
    expect(PRIVATE_COMPANY_CATALOG[JK_PRIVATE_ID]).toMatchObject({ acronym: "JK", faceValue: 120, revenue: 20 });
  });

  it("stay out of a standard deal", () => {
    const base = sandboxGameState("WaterfallAuction", 1);
    const dealt = applySandboxAction(base, { SetupGame: { players: seats(4), variants: {} } } as never);
    expect(dealt.public_companies).toHaveLength(8);
    expect(dealt.private_companies).toHaveLength(6);
  });
});

describe("station tokens cost $100 after the home one (design note #1320)", () => {
  it("prices every placement after the first at $100 on this board, and $40 then $100 elsewhere", () => {
    withRules(LPF, () => {
      expect(stationTokenPrice(0)).toBe(0);
      expect(stationTokenPrice(1)).toBe(100);
      expect(stationTokenPrice(2)).toBe(100);
      expect(stationTokenPrice(3)).toBe(100);
      // PRR's herald home (#1302): its first placement is its second station, so $100 here too.
      expect(stationTokenPrice(0, true)).toBe(100);
      const slots = stationTokenSlots({ station_token_hexes: [], station_token_limit: 4 });
      expect(slots.map((slot) => slot.cost)).toEqual([0, 100, 100, 100]);
    });
    expect(stationTokenPrice(1)).toBe(40);
    withRules(PLUS, () => expect(stationTokenPrice(1)).toBe(40));
  });
});
