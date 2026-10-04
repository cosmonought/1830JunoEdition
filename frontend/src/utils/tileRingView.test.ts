// frontend/src/utils/tileRingView.test.ts
//
// Phase 3 W1-E (AUD-05.01 U-38, P3-N010, P3-N011 / LOW-4; Phase-4 pre-work for AUD-05.04): the tile ring opens on a
// facing the station authority keeps, cannot confirm a lay the lay authority refuses, says the authority's own
// sentence when it cannot, is latched while a press is in flight, and names errata tiles canonically.
//
// THE VERDICTS ARE ASKED OF REAL BOARDS: the New York #62 -> #883 OO fixture `stage101LayTileAuthority.test.ts` uses
// (two stations, some facings strand one) and the JUNO-CV4 golden walked to B&O's first paid lay (#891's fee).

import { readFileSync } from "fs";
import { join } from "path";

import {
  RING_IN_FLIGHT_REASON,
  ringConfirmState,
  ringLayMessage,
  ringLayPreviewRefusal,
  seedRingFacing,
  type RingLayPreview,
} from "./tileRingView";
import { readShell, readSource, sliceBetween, sliceFrom, stripComments } from "./sourceScan";
import { LegacyLogAdapters, RoomEngine, entriesFromExport, type ExportedEntry, type ReplayEntry } from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY, replayCompatibility } from "../gameEngine/rulesVersion";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { effectiveActions } from "../gameEngine/logRevert";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenarioState } from "../gameEngine/sandboxState";
import { withEmptyRoster } from "../gameEngine/gameSetup";
import { terrainAffordabilityRefusal } from "../gameEngine/layTileAuthority";
import { stationAnchorPlan, stationAnchorRefusal, stationLegalFacings } from "../gameEngine/stationAnchorAuthority";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { terrainBuildFeeAt } from "../components/hexBoardData";
import { canonicalTileName } from "../components/hexTileCatalog";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";

/* babel-jest hoists `jest.mock` above every import, so this block runs exactly where it did when it sat above them;
   it is written below them only for `import/first`. The recorder is read lazily, inside the wrapped `withRules`. */
const withRulesCalls: unknown[][] = [];
jest.mock("../gameEngine/boardSelection", () => {
  const actual = jest.requireActual("../gameEngine/boardSelection");
  return {
    ...actual,
    withRules: (...args: unknown[]) => {
      withRulesCalls.push(args);
      return (actual.withRules as (...a: unknown[]) => unknown)(...args);
    },
  };
});

/* ---------------------------------------------------------------------------------------------------- */
/*  Fixtures                                                                                             */
/* ---------------------------------------------------------------------------------------------------- */

const NY = { q: 6, r: 6 };
const NYC = 2;
const NNH = 7;
const ALL = [0, 1, 2, 3, 4, 5];

function tokened(id: number, ticker: string, city: number): StationTokenCompany {
  return {
    company_id: id,
    ticker,
    is_floated: true,
    station_token_hexes: [[NY.q, NY.r]],
    station_tokens: [[NY.q, NY.r, city]],
  } as unknown as StationTokenCompany;
}

/** The New York OO with NYC and NNH each in a city of #62, NYC operating at Lay Track; the Plus tray (#883). */
function newYork(): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [NYC],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: "Track",
    terrain_fees_paid: [],
    variants: { expandedMap: true, plusTiles: true },
    public_companies: [tokened(NYC, "NYC", 0), tokened(NNH, "NNH", 1)].map((company) => ({
      ...company,
      president: "p1",
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: "1000",
      owned_trains: ["4"],
      player_holdings: [{ player: "p1", percentage: 100 }],
    })),
  } as unknown as GameStateResponse;
}

const withSixtyTwo: MapGridResponse = {
  game_id: 1,
  tiles: [{ q: NY.q, r: NY.r, tile_id: 62, orientation: 1, landmark: "New York" }],
};

/** The station question isolated: geometry has no opinion here (#757's "no provider, no opinion"), so whatever the
 *  ring is refused for is the station authority's sentence. The golden block below uses the real providers. */
const STATION_ONLY = { layRefused: () => false, chartInjections: () => ({}) };

function nyLay(orientation: number, state: GameStateResponse): RingLayPreview {
  /* The landings the preview would hold: `derivePreviewLandings` IS `stationAnchorPlan` with no free choice. */
  const { tokenCities } = stationAnchorPlan(state, withSixtyTwo, { q: NY.q, r: NY.r, tileId: 883, orientation }, NYC);
  return {
    gameId: 1,
    protocolId: NYC,
    q: NY.q,
    r: NY.r,
    tileId: 883,
    orientation,
    bonusLay: false,
    abilityKey: undefined,
    tokenCity: undefined,
    tokenCities,
  };
}

/* ---------------------------------------------------------------------------------------------------- */
/*  The facing seed                                                                                      */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-E: the ring opens on a facing the station authority keeps", () => {
  it("the seed is the lowest facing `stationLegalFacings` keeps, whatever raw facing the ring offered", () => {
    const state = newYork();
    const legal = stationLegalFacings(state, withSixtyTwo, NY.q, NY.r, 883, ALL, NYC);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.length).toBeLessThan(ALL.length); // some facing strands a station: there is something to avoid
    const illegal = ALL.find((orientation) => !legal.includes(orientation))!;
    expect(seedRingFacing(illegal, legal)).toBe(legal[0]);
    // An offer that is already legal still opens on the thumbnail's facing (#879: "the marker on the thumbnail is
    // the marker they then see on the board").
    expect(seedRingFacing(legal[legal.length - 1], legal)).toBe(legal[0]);
  });

  it("with no legal facing the ring's own offer is kept (there is nothing to prefer), and Confirm says why", () => {
    expect(seedRingFacing(4, [])).toBe(4);
    const state = newYork();
    const legal = stationLegalFacings(state, withSixtyTwo, NY.q, NY.r, 883, ALL, NYC);
    const illegal = ALL.find((orientation) => !legal.includes(orientation))!;
    const refusal = ringLayPreviewRefusal(STATION_ONLY, state, withSixtyTwo, nyLay(illegal, state));
    expect(refusal).not.toBeNull();
    expect(ringConfirmState({ layDisabledReason: null, inFlight: false, previewRefusal: refusal })).toEqual({
      canConfirm: false,
      reason: refusal,
    });
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  The preview verdict is the authority's                                                               */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-E: the previewed lay is judged by `layTileRefusal`, not a shell restatement", () => {
  it("an illegal facing is refused with the station authority's own sentence; the seeded facing is accepted", () => {
    const state = newYork();
    const legal = stationLegalFacings(state, withSixtyTwo, NY.q, NY.r, 883, ALL, NYC);
    for (const orientation of ALL) {
      const lay = nyLay(orientation, state);
      const authority = withRules(resolveVariants(state.variants), () =>
        stationAnchorRefusal(
          state,
          { q: NY.q, r: NY.r, tile_id: 883, orientation, ...(lay.tokenCities.length ? { token_cities: lay.tokenCities } : {}) },
          withSixtyTwo,
        ),
      );
      const preview = ringLayPreviewRefusal(STATION_ONLY, state, withSixtyTwo, lay);
      expect(preview).toBe(authority);
      expect(preview === null).toBe(legal.includes(orientation));
    }
    const seeded = seedRingFacing(ALL.find((o) => !legal.includes(o))!, legal);
    expect(ringLayPreviewRefusal(STATION_ONLY, state, withSixtyTwo, nyLay(seeded, state))).toBeNull();
  });

  it("is asked on the table's rules AND its route revision (LOW-4)", () => {
    const pinned = { ...newYork(), rules_engine_version: 12 } as unknown as GameStateResponse;
    for (const state of [newYork(), pinned]) {
      withRulesCalls.length = 0;
      ringLayPreviewRefusal(STATION_ONLY, state, withSixtyTwo, nyLay(0, state));
      expect(withRulesCalls.length).toBeGreaterThan(0);
      expect(withRulesCalls[0][2]).toBe(routeRulesRevisionOf(state));
    }
    expect(routeRulesRevisionOf(newYork())).not.toBe(routeRulesRevisionOf(pinned));
  });

  it("sends nothing optional the confirm handler would not send (#232: absent is not said)", () => {
    const bare = ringLayMessage({ ...nyLay(0, newYork()), tokenCities: [] });
    expect(Object.keys(bare.LayTile).sort()).toEqual(["game_id", "orientation", "protocol_id", "q", "r", "tile_id"]);
    const full = ringLayMessage({ ...nyLay(0, newYork()), bonusLay: true, abilityKey: "csl-tile", tokenCity: 1, tokenCities: [[NYC, 1]] });
    expect(full.LayTile).toMatchObject({ bonus_lay: true, ability_key: "csl-tile", token_city: 1, token_cities: [[NYC, 1]] });
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  The golden: #891's unaffordable lay greys the tick with the authority's fee sentence                 */
/* ---------------------------------------------------------------------------------------------------- */

const GOLDEN = join(__dirname, "__fixtures__", "replayGolden", "logs", "JUNO-CV4.log.jsonl");

function goldenEntries(): ReplayEntry[] {
  const rows = readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExportedEntry);
  const ordered = entriesFromExport(rows).sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  return effectiveActions(ordered);
}

type LayBody = { protocol_id: number; q: number; r: number; tile_id: number; orientation: number };

describe("W1-E on the golden: the real providers, the real board", () => {
  const providers = sandboxReplayProviders();
  const entries = goldenEntries();
  const found = (() => {
    for (const entry of entries) {
      const msg = JSON.parse(entry.payload) as { LayTile?: LayBody };
      if (!msg.LayTile) continue;
      const fee = withRules(resolveVariants({}), () => terrainBuildFeeAt(msg.LayTile!.q, msg.LayTile!.r));
      if (fee > 0) return { entry, lay: msg.LayTile };
    }
    throw new Error("JUNO-CV4 carries no terrain lay");
  })();
  const engine = new RoomEngine(providers, {
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: null,
  });
  const adapters = new LegacyLogAdapters(providers, replayCompatibility(entries), DEVELOPMENT_CORPUS_POLICY);
  for (const entry of entries) {
    if (entry.index === found.entry.index) break;
    adapters.apply(engine, entry);
  }
  const state = engine.snapshot.state;
  const grid = engine.snapshot.grid;
  const preview: RingLayPreview = {
    gameId: 0,
    protocolId: found.lay.protocol_id,
    q: found.lay.q,
    r: found.lay.r,
    tileId: found.lay.tile_id,
    orientation: found.lay.orientation,
    bonusLay: false,
    abilityKey: undefined,
    tokenCity: undefined,
    tokenCities: [],
  };

  it("CONTROL: the recorded lay is lit", () => {
    expect(ringLayPreviewRefusal(providers, state, grid, preview)).toBeNull();
  });

  it("#891 / #1382: an emptied treasury greys the tick with the authority's fee sentence, not a shell-built one", () => {
    const broke = {
      ...state,
      public_companies: state.public_companies.map((company) =>
        company.company_id === found.lay.protocol_id ? { ...company, treasury: "0" } : company,
      ),
    } as GameStateResponse;
    const refusal = ringLayPreviewRefusal(providers, broke, grid, preview);
    expect(refusal).not.toBeNull();
    expect(refusal).toBe(
      withRules(resolveVariants(broke.variants), () => terrainAffordabilityRefusal(broke, { ...found.lay })),
    );
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  The confirm gate                                                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-E: one answer for the tick and its tooltip, latched while a press travels", () => {
  it("orders who-may-lay, then the latch, then the lay's own verdict", () => {
    expect(ringConfirmState({ layDisabledReason: "not now", inFlight: true, previewRefusal: "refused" })).toEqual({
      canConfirm: false,
      reason: "not now",
    });
    expect(ringConfirmState({ layDisabledReason: null, inFlight: true, previewRefusal: "refused" })).toEqual({
      canConfirm: false,
      reason: RING_IN_FLIGHT_REASON,
    });
    expect(ringConfirmState({ layDisabledReason: null, inFlight: false, previewRefusal: "refused" })).toEqual({
      canConfirm: false,
      reason: "refused",
    });
    expect(ringConfirmState({ layDisabledReason: null, inFlight: false, previewRefusal: null })).toEqual({
      canConfirm: true,
      reason: undefined,
    });
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  The shell's wiring (source pins; comments stripped)                                                  */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-E wiring in the shell", () => {
  const APP = readShell();

  it("the ring's tick, tooltip and press all read the one confirm answer", () => {
    const ring = sliceBetween(APP, "<RadialTileSelector", "onDismiss={handleDismissRadial}");
    expect(ring).toContain("canConfirm={ringConfirm.canConfirm}");
    expect(ring).toContain("confirmDisabledReason={ringConfirm.reason}");
    expect(ring).toContain("if (ringConfirm.canConfirm) handleConfirmRadialLay();");
    expect(ring).not.toContain("pendingLayCost?.short");
    expect(ring).not.toContain("onConfirm={handleConfirmRadialLay}");
    const gate = sliceBetween(APP, "const ringConfirm = useMemo(", "ringLayRefusal],");
    expect(gate).toContain("layDisabledReason: tileLayDisabledReason,");
    expect(gate).toContain("inFlight: actionInFlight || previewTile?.committed === true,");
    expect(gate).toContain("previewRefusal: ringLayRefusal,");
  });

  it("the preview memo asks the authority on the message the handler sends, and derives no landings itself", () => {
    const memo = sliceBetween(APP, "const ringLayRefusal = useMemo(", "const ringConfirm = useMemo(");
    expect(memo).toContain("ringLayPreviewRefusal(SHELL_PROVIDERS, gameState, mapGrid, {");
    expect(memo).toContain("bonusLay: errandLaysBonus(homeStationPlacement) && claimsErrand,");
    expect(memo).toContain("tokenCities: previewTile.tokenCities ?? [],");
    expect(memo).not.toContain("derivePreviewLandings(");
    // The pinned call sites are untouched: three multi-line, four in all (stationConnectivity / previewTokenLanding).
    expect((APP.match(/derivePreviewLandings\(\n/g) ?? []).length).toBe(3);
    expect((APP.match(/derivePreviewLandings\(/g) ?? []).length).toBe(4);
  });

  it("the selection seeds its facing from the station authority, and every later step uses the seed", () => {
    const select = sliceBetween(APP, "onSelectCandidate={(tileId, orientation) => {", "legalRotationCount=");
    expect(select).toContain("const facing = seedRingFacing(");
    expect(select).toContain("stationLegalFacings(gameState, mapGrid, radialSelector.q, radialSelector.r, tileId,");
    expect(select).toContain("orientation: facing,");
    expect(select).toContain("orientation: seed.orientation,");
    // The raw offer reaches nothing but the seed: both landings calls are asked at the seeded facing.
    const probe = sliceBetween(select, "const probe = derivePreviewLandings(", ");");
    expect(probe).toContain("facing,");
    expect(probe).not.toMatch(/\borientation\b/);
    const landing = sliceBetween(select, "const landing = derivePreviewLandings(", ");");
    expect(landing).toContain("seed.orientation,");
  });

  it("`tileLayDisabledReason` reads the lay authority's step and second-lay sentences", () => {
    const gate = sliceBetween(APP, "const tileLayDisabledReason = useMemo(", "const canLayTileNow =");
    expect(gate).toContain("layTimingRefusal(gameState, { protocol_id: actingProtocolId })");
    expect(gate).toContain("ordinaryLayTakenRefusal(gameState, { protocol_id: actingProtocolId, bonus_lay: errandLaysBonus(homeStationPlacement) })");
    expect(gate).not.toContain("gameState?.ordinary_lay_taken === actingProtocolId");
    // The shell's own step test survives only where the authority has no timing opinion (a legacy board).
    expect(gate).toContain('typeof gameState?.rules_engine_version !== "number" && orSubPhase !== "Track"');
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  U-38: canonical names                                                                                */
/* ---------------------------------------------------------------------------------------------------- */

describe("W1-E (U-38): errata tiles are named canonically on the receipt and in the ring's aria labels", () => {
  it("the catalog's canonical name is the corrected one", () => {
    expect(canonicalTileName(626)).toBe("#8861");
    expect(canonicalTileName(57)).toBe("#57");
  });

  it("the no-upgrade receipt names the tile canonically", () => {
    const APP = readShell();
    const receipt = sliceFrom(APP, "isUpgradeDeadEnd(laidHere.tile_id)", { length: 300 });
    expect(receipt).toContain("showActionToast(`Tile ${canonicalTileName(laidHere.tile_id)} has no upgrade in this game");
    expect(receipt).not.toContain("Tile #${laidHere.tile_id}");
  });

  it("every ring aria label that names a tile names it canonically", () => {
    const RING = stripComments(readSource("components/RadialTileSelector.tsx"));
    for (const label of [
      "`Tile ${canonicalTileName(tile.tileId)} — none left in the supply`",
      "`Preview tile ${canonicalTileName(tile.tileId)} on ${hexLabel}`",
      "`Tile ${canonicalTileName(tile.tileId)} does not upgrade further`",
      "copies of tile ${canonicalTileName(tile.tileId)} remain`",
    ]) {
      expect(RING).toContain(label);
    }
    // No label spells a tile by its storage key any more.
    expect(RING).not.toMatch(/[Tt]ile \$\{tile\.tileId\}/);
  });
});
