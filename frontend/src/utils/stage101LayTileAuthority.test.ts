// frontend/src/utils/stage101LayTileAuthority.test.ts
//
// Stage 10.1 (S10-26, S10-25, the LayTile half of S10-4): a refused `LayTile` changes NOTHING, on every atom.
//
// ==================================================================
//  DESIGN NOTE 1683 (tests): THE PROOF THE ORIENTATION AUDIT RAN BY HAND, PINNED
// ==================================================================
//
// The Stage-10 orientation audit replayed the frozen JUNO-CV4 golden to B&O's first lay (index 27, #57 at
// (2,9), an $80 river), zeroed the treasury, and applied the stored entry through `RoomEngine`: the treasury
// stayed $0, the tile LANDED ON THE GRID, and the cursor moved Track -> Tokens. Three atoms, three answers.
// This file runs that probe as a test, beside the smaller cases -- the JK, the station anchoring, the ring's
// rotation list -- and pins the property the slice exists for: the grid, the reducer and the live ingress
// ask ONE composition (`layTileRefusal` / `layTileLegalityRefusal`), and a lay one of them refuses is a lay
// none of them applies.
//
// READ-ONLY OVER THE GOLDEN. The fixture is walked with the same adapters `replayGolden.test.ts` uses and is
// never written; the crafted case patches one treasury on an in-memory board.

import { readFileSync } from "fs";
import { join } from "path";

import {
  LegacyLogAdapters,
  RoomEngine,
  entriesFromExport,
  type ExportedEntry,
  type ReplayEntry,
} from "../gameEngine/replayLog";
import { DEVELOPMENT_CORPUS_POLICY, replayCompatibility } from "../gameEngine/rulesVersion";
import { boardLayRefused, sandboxReplayProviders } from "../gameEngine/replayProviders";
import { effectiveActions } from "../gameEngine/logRevert";
import { stateDigest } from "../gameEngine/stateDigest";
import { DEFAULT_SANDBOX_SCENARIO, sandboxGameState, sandboxScenarioState } from "../gameEngine/sandboxState";
import { withEmptyRoster } from "../gameEngine/gameSetup";
import { applySandboxAction, applySandboxLayTile } from "../gameEngine/sandboxSession";
import {
  layTerrainFee,
  layTileLegalityRefusal,
  layTileRefusal,
  terrainAffordabilityRefusal,
} from "../gameEngine/layTileAuthority";
import {
  stationAnchorPlan,
  stationAnchorRefusal,
  stationLegalFacings,
} from "../gameEngine/stationAnchorAuthority";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { operatingCorporationId } from "../gameEngine/dividendGate";
import { tileEraFor } from "../gameEngine/gameConstants";
import { terrainBuildFeeAt } from "../components/hexBoardData";
import { withRules } from "../gameEngine/boardSelection";
import { resolveVariants } from "../gameEngine/gameVariants";
import { withLevelPlayingFieldEntities, JK_PRIVATE_ID } from "../gameEngine/levelPlayingField";
import { JK_TILE_ABILITY_KEY } from "../gameEngine/kanawhaLicense";
import { planTokenUpgrade, tokenLandingsFor } from "./tokenMigration";
import type { GameStateResponse } from "../gameEngine/gameState";
import type { GameplayExecuteMsg } from "./sessionKey";
import type { MapGridResponse, StationTokenCompany } from "../components/hexContractTypes";

/* ---------------------------------------------------------------------------------------------------- */
/*  The golden walk (JUNO-CV4 to B&O's first lay), as the orientation audit ran it                       */
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

/** The engine walked to just before `index`, with the development corpus's adapters (the home choice B&O
 *  recorded in a Stock Round is supplied at its first turn, #1614), exactly as `replayGolden.test.ts` walks. */
function walkTo(entries: readonly ReplayEntry[], index: number): RoomEngine {
  const providers = sandboxReplayProviders();
  const seed = withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default"));
  const engine = new RoomEngine(providers, { state: seed, waterfall: null });
  const adapters = new LegacyLogAdapters(providers, replayCompatibility(entries), DEVELOPMENT_CORPUS_POLICY);
  for (const entry of entries) {
    if (entry.index === index) break;
    adapters.apply(engine, entry);
  }
  return engine;
}

/** The first stored lay on ground the board charges for, found rather than hard-coded. */
function firstPaidLay(entries: readonly ReplayEntry[]): { entry: ReplayEntry; lay: LayBody; fee: number } {
  for (const entry of entries) {
    const msg = JSON.parse(entry.payload) as { LayTile?: LayBody };
    if (!msg.LayTile) continue;
    const fee = withRules(resolveVariants({}), () => terrainBuildFeeAt(msg.LayTile!.q, msg.LayTile!.r));
    if (fee > 0) return { entry, lay: msg.LayTile, fee };
  }
  throw new Error("JUNO-CV4 carries no terrain lay");
}

type LayBody = { protocol_id: number; q: number; r: number; tile_id: number; orientation: number };

function tileAt(grid: MapGridResponse, q: number, r: number) {
  return grid.tiles.find((tile) => tile.q === q && tile.r === r);
}

function treasuryOf(state: GameStateResponse, companyId: number): number {
  return Number(state.public_companies.find((company) => company.company_id === companyId)?.treasury ?? NaN);
}

/** A board like `engine`'s, with one treasury replaced -- the crafted client's board IS the server's. */
function withTreasury(engine: RoomEngine, companyId: number, treasury: string): void {
  const state = engine.snapshot.state;
  (engine as unknown as { state: GameStateResponse }).state = {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === companyId ? { ...company, treasury } : company,
    ),
  };
}

describe("A/B. the golden's first paid lay: legal as recorded, refused on every atom when unaffordable", () => {
  const entries = goldenEntries();
  const { entry, lay, fee } = firstPaidLay(entries);

  it("A. CONTROL -- the recorded lay lands, charges the treasury, pays the Bank, marks the ground and ends the step", () => {
    const engine = walkTo(entries, entry.index);
    const before = engine.snapshot.state;
    expect(operatingCorporationId(before)).toBe(lay.protocol_id);
    expect(before.operating_sub_phase).toBe("Track");
    const bankBefore = Number(before.virtual_bank_vgp);
    const treasuryBefore = treasuryOf(before, lay.protocol_id);

    engine.apply(entry);
    const after = engine.snapshot.state;
    expect(tileAt(engine.snapshot.grid, lay.q, lay.r)).toMatchObject({ tile_id: lay.tile_id, orientation: lay.orientation });
    expect(treasuryOf(after, lay.protocol_id)).toBe(treasuryBefore - fee);
    expect(Number(after.virtual_bank_vgp)).toBe(bankBefore + fee);
    expect(after.terrain_fees_paid ?? []).toContain(`${lay.q},${lay.r}`);
    expect(after.operating_sub_phase).toBe("Tokens");
  });

  it("B. UNAFFORDABLE -- the same lay with the treasury emptied changes neither atom nor the cursor", () => {
    const engine = walkTo(entries, entry.index);
    withTreasury(engine, lay.protocol_id, "0");
    const before = engine.snapshot.state;
    const gridBefore = engine.snapshot.grid;
    const digestBefore = stateDigest(before);

    engine.apply(entry);
    const after = engine.snapshot.state;
    expect(engine.snapshot.grid).toBe(gridBefore); // IDENTITY: the grid was not even copied
    expect(tileAt(engine.snapshot.grid, lay.q, lay.r)).toBeUndefined();
    expect(stateDigest(after)).toBe(digestBefore);
    expect(after.operating_sub_phase).toBe("Track");
    expect(after.terrain_fees_paid ?? []).toEqual(before.terrain_fees_paid ?? []);
    expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
    expect(treasuryOf(after, lay.protocol_id)).toBe(0);
  });

  it("B. INGRESS -- the live authority answers the crafted lay with the terrain sentence before anything moves", () => {
    const engine = walkTo(entries, entry.index);
    withTreasury(engine, lay.protocol_id, "0");
    const state = engine.snapshot.state;
    const grid = engine.snapshot.grid;
    const president = state.public_companies.find((company) => company.company_id === lay.protocol_id)?.president ?? null;
    const providers = sandboxReplayProviders();
    const msg = JSON.parse(entry.payload) as GameplayExecuteMsg;
    const refusal = turnRefusal({
      state,
      waterfall: state.waterfall ?? null,
      actor: president,
      msg,
      mapGrid: grid,
      layRefused: (q, r, tileId, orientation) => providers.layRefused(grid, q, r, tileId, orientation, tileEraFor(state)),
    });
    expect(refusal).toMatch(/cannot pay the \$80 terrain cost/);
    // The same sentence the reducer's gate and the grid's predicate see -- one composition, three askers.
    expect(
      withRules(resolveVariants(state.variants), () =>
        layTileRefusal(state, msg, {
          mapGrid: grid,
          layRefused: (q, r, tileId, orientation) => providers.layRefused(grid, q, r, tileId, orientation, tileEraFor(state)),
        }),
      ),
    ).toBe(refusal);
    // And the recorded (affordable) lay is answered `null` by the same path: the control is not refused.
    const control = walkTo(entries, entry.index);
    const affordable = control.snapshot.state;
    expect(
      turnRefusal({
        state: affordable,
        waterfall: affordable.waterfall ?? null,
        actor: president,
        msg,
        mapGrid: control.snapshot.grid,
        layRefused: (q, r, tileId, orientation) =>
          providers.layRefused(control.snapshot.grid, q, r, tileId, orientation, tileEraFor(affordable)),
      }),
    ).toBeNull();
  });

  it("B. the fee the gate judges is the fee the arm charges", () => {
    const engine = walkTo(entries, entry.index);
    const state = engine.snapshot.state;
    expect(withRules(resolveVariants(state.variants), () => layTerrainFee(state, lay))).toBe(fee);
    expect(withRules(resolveVariants(state.variants), () => terrainAffordabilityRefusal(state, lay))).toBeNull();
    withTreasury(engine, lay.protocol_id, String(fee - 1));
    expect(
      withRules(resolveVariants(state.variants), () => terrainAffordabilityRefusal(engine.snapshot.state, lay)),
    ).toMatch(/cannot pay/);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  C. the JK's half-price lay                                                                          */
/* ---------------------------------------------------------------------------------------------------- */

const LPF = resolveVariants({ levelPlayingField: true });
const PRR = 1;
const P1 = "juno1alice";

function lpfOperating(treasury: string): GameStateResponse {
  const base = withLevelPlayingFieldEntities({ ...sandboxGameState("OperatingRound", 1), variants: LPF });
  return {
    ...base,
    current_round_type: "OperatingRound",
    current_global_era: "Yellow",
    active_operating_order: [PRR],
    active_corporation_index: 0,
    operating_sub_phase: "Track",
    public_companies: base.public_companies.map((company) => ({
      ...company,
      president: company.company_id === PRR ? P1 : null,
      is_floated: company.company_id === PRR,
      treasury: company.company_id === PRR ? treasury : "0",
      par_value: company.company_id === PRR ? "100" : null,
      player_holdings: company.company_id === PRR ? [{ player: P1, percentage: 60 }] : [],
      ipo_pool_percentage: company.company_id === PRR ? 40 : 100,
      bank_pool_percentage: 0,
      owned_trains: [],
      station_token_hexes: [],
      station_tokens: [],
      kanawha_licenses: undefined,
    })),
    private_companies: base.private_companies.map((entry) => ({
      ...entry,
      owner: null,
      owner_protocol_id: entry.private_id === JK_PRIVATE_ID ? PRR : null,
      closed: false,
    })),
    kanawha_licenses_sold: undefined,
    jk_license_granted: undefined,
    used_private_abilities: [],
    terrain_fees_paid: [],
  } as GameStateResponse;
}

// K9 is (-1, 10): Coal River's NE neighbour, a $120 mountain -- $60 under the JK's power.
const JK_LAY = { game_id: 1, protocol_id: PRR, q: -1, r: 10, tile_id: 8, orientation: 0, ability_key: JK_TILE_ABILITY_KEY };

describe("C. a JK lay the power does not cover, or the treasury cannot pay, spends nothing", () => {
  it("an unaffordable JK lay leaves the JK open, the power unspent, the cursor on Track, and the state by identity", () => {
    const state = lpfOperating("59"); // one dollar short of the half fee
    const msg = { LayTile: JK_LAY } as unknown as GameplayExecuteMsg;
    const after = applySandboxAction(state, msg);
    expect(after).toBe(state);
    expect(after.private_companies.find((entry) => entry.private_id === JK_PRIVATE_ID)?.closed).toBe(false);
    expect(after.used_private_abilities).toEqual([]);
    expect(after.operating_sub_phase).toBe("Track");
    expect(withRules(LPF, () => layTileLegalityRefusal(state, JK_LAY))).toMatch(/cannot pay the \$60 terrain cost/);
  });

  it("a JK lay by a corporation that does not own the JK is refused by identity, with the JK's own sentence", () => {
    const state = lpfOperating("1000");
    const notOwner = {
      ...state,
      private_companies: state.private_companies.map((entry) =>
        entry.private_id === JK_PRIVATE_ID ? { ...entry, owner_protocol_id: null } : entry,
      ),
    };
    const msg = { LayTile: JK_LAY } as unknown as GameplayExecuteMsg;
    expect(applySandboxAction(notOwner, msg)).toBe(notOwner);
    expect(withRules(LPF, () => layTileLegalityRefusal(notOwner, JK_LAY))).toMatch(/owns the JK/);
    // The grid, asked the same composition, does not move either.
    const bare: MapGridResponse = { game_id: 1, tiles: [] };
    const gridAfter = withRules(LPF, () =>
      applySandboxLayTile(bare, JK_LAY.q, JK_LAY.r, JK_LAY.tile_id, JK_LAY.orientation, () =>
        layTileRefusal(notOwner, msg, { mapGrid: bare }) !== null,
      ),
    );
    expect(gridAfter).toBe(bare);
  });

  it("the legal JK lay still lays at half the mountain and closes the JK (the control, unchanged from #1323)", () => {
    const state = lpfOperating("1000");
    const msg = { LayTile: JK_LAY } as unknown as GameplayExecuteMsg;
    const after = applySandboxAction(state, msg);
    expect(after).not.toBe(state);
    expect(treasuryOf(after, PRR)).toBe(1000 - 60);
    expect(after.private_companies.find((entry) => entry.private_id === JK_PRIVATE_ID)?.closed).toBe(true);
    expect(after.used_private_abilities).toContain(JK_TILE_ABILITY_KEY);
    expect(after.operating_sub_phase).toBe("Tokens");
    expect(withRules(LPF, () => layTerrainFee(state, JK_LAY))).toBe(60);
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  D / E. station anchoring: both atoms, and the ring's rotation list                                  */
/* ---------------------------------------------------------------------------------------------------- */

const STANDARD = resolveVariants({});
const PLUS = resolveVariants({ expandedMap: true, plusTiles: true });
const NY = { q: 6, r: 6 };
const E11 = { q: 3, r: 4 };
const NYC = 2;
const NNH = 7;
const BO = 4;

function stateWith(companies: StationTokenCompany[], operating = NYC): GameStateResponse {
  return {
    player_addresses: ["p1"],
    player_cash: [{ player: "p1", cash_vgp: "500" }],
    virtual_bank_vgp: "10000",
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [operating],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 2,
    consecutive_passes: 0,
    operating_sub_phase: "Track",
    terrain_fees_paid: [],
    public_companies: companies.map((company) => ({
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

function tokened(id: number, ticker: string, hex: { q: number; r: number }, city: number): StationTokenCompany {
  return {
    company_id: id,
    ticker,
    is_floated: true,
    station_token_hexes: [[hex.q, hex.r]],
    station_tokens: [[hex.q, hex.r, city]],
  } as unknown as StationTokenCompany;
}

function unindexed(id: number, ticker: string, hex: { q: number; r: number }): StationTokenCompany {
  return {
    company_id: id,
    ticker,
    is_floated: true,
    station_token_hexes: [[hex.q, hex.r]],
    station_tokens: null,
  } as unknown as StationTokenCompany;
}

const withSixtyTwo: MapGridResponse = {
  game_id: 1,
  tiles: [{ q: NY.q, r: NY.r, tile_id: 62, orientation: 1, landmark: "New York" }],
};

describe("D. a station landing ❹ forbids changes neither atom; a legal facing applies on both", () => {
  it("crafted token_cities on an illegal facing: reducer by identity, grid by identity, cursor unmoved", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0), tokened(NNH, "NNH", NY, 1)]);
      const illegal = [0, 1, 2, 3, 4, 5].find(
        (orientation) =>
          stationAnchorRefusal(
            state,
            { q: NY.q, r: NY.r, tile_id: 883, orientation, token_cities: [[NYC, 0], [NNH, 0]] },
            withSixtyTwo,
          ) !== null,
      );
      expect(illegal).toBeDefined();
      const msg = {
        LayTile: { game_id: 1, protocol_id: NYC, q: NY.q, r: NY.r, tile_id: 883, orientation: illegal!, token_cities: [[NYC, 0], [NNH, 0]] },
      } as unknown as GameplayExecuteMsg;
      const ctx = { mapGrid: withSixtyTwo };
      expect(layTileRefusal(state, msg, ctx)).not.toBeNull();
      const after = applySandboxAction(state, msg, ctx);
      expect(after).toBe(state);
      expect(after.operating_sub_phase).toBe("Track");
      const grid = applySandboxLayTile(withSixtyTwo, NY.q, NY.r, 883, illegal!, () => layTileRefusal(state, msg, ctx) !== null);
      expect(grid).toBe(withSixtyTwo);
    });
  });

  it("the legal facing lands on both atoms, and its `token_cities` are the authority's own landings", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0), tokened(NNH, "NNH", NY, 1)]);
      const verdict = stationAnchorPlan(state, withSixtyTwo, { q: NY.q, r: NY.r, tileId: 883, orientation: 3 }, NYC);
      expect(verdict.refusal).toBeNull();
      expect(verdict.tokenCities).toEqual([[NYC, 0], [NNH, 0]]);
      const msg = {
        LayTile: { game_id: 1, protocol_id: NYC, q: NY.q, r: NY.r, tile_id: 883, orientation: 3, token_cities: verdict.tokenCities },
      } as unknown as GameplayExecuteMsg;
      const ctx = { mapGrid: withSixtyTwo };
      expect(layTileRefusal(state, msg, ctx)).toBeNull();
      expect(applySandboxAction(state, msg, ctx)).not.toBe(state);
      const grid = applySandboxLayTile(withSixtyTwo, NY.q, NY.r, 883, 3, () => layTileRefusal(state, msg, ctx) !== null);
      expect(grid).not.toBe(withSixtyTwo);
      expect(tileAt(grid, NY.q, NY.r)).toMatchObject({ tile_id: 883, orientation: 3 });
    });
  });
});

describe("E. the ring's rotation list and the preview's landings are the station authority's answer", () => {
  it("the legal facings are exactly those `stationAnchorRefusal` accepts on the landings the lay would carry", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0), tokened(NNH, "NNH", NY, 1)]);
      const all = [0, 1, 2, 3, 4, 5];
      const offered = stationLegalFacings(state, withSixtyTwo, NY.q, NY.r, 883, all, NYC);
      const accepted = all.filter((orientation) => {
        const { tokenCities } = stationAnchorPlan(state, withSixtyTwo, { q: NY.q, r: NY.r, tileId: 883, orientation }, NYC);
        return (
          stationAnchorRefusal(
            state,
            { q: NY.q, r: NY.r, tile_id: 883, orientation, ...(tokenCities.length ? { token_cities: tokenCities } : {}) },
            withSixtyTwo,
          ) === null
        );
      });
      expect(offered).toEqual(accepted);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.length).toBeLessThan(all.length); // some facing strands a station: the filter is doing work
      // And the list is strictly narrower than the raw plan when the plan alone would say yes.
      const rawPlanSaysYes = all.filter(
        (orientation) => planTokenUpgrade(withSixtyTwo, NY.q, NY.r, state.public_companies as unknown as StationTokenCompany[], 883, orientation) !== null,
      );
      expect(rawPlanSaysYes).toEqual(expect.arrayContaining(offered));
    });
  });

  it("#1625's total-slot floor is in the ring: three free stations on a bare OO hex get NO facing of #59, where the raw plan offered them all", () => {
    withRules(STANDARD, () => {
      const bare: MapGridResponse = { game_id: 1, tiles: [] };
      const three = stateWith([unindexed(NYC, "NYC", E11), unindexed(NNH, "NNH", E11), unindexed(BO, "B&O", E11)]);
      const all = [0, 1, 2, 3, 4, 5];
      // The raw plan -- what `legalRotations` used to ask -- keeps every facing: the tokens are free.
      const raw = all.filter(
        (orientation) => planTokenUpgrade(bare, E11.q, E11.r, three.public_companies as unknown as StationTokenCompany[], 59, orientation) !== null,
      );
      expect(raw.length).toBeGreaterThan(0);
      // The authority's list keeps none: a two-slot tile cannot seat three stations.
      expect(stationLegalFacings(three, bare, E11.q, E11.r, 59, all, NYC)).toEqual([]);
      // Two stations, two slots: the same facings the raw plan offers survive.
      const two = stateWith([unindexed(NYC, "NYC", E11), unindexed(NNH, "NNH", E11)]);
      expect(stationLegalFacings(two, bare, E11.q, E11.r, 59, all, NYC)).toEqual(Array.from(new Set(raw)).sort((a, b) => a - b));
    });
  });

  it("the preview's landings are `tokenLandingsFor` over the authority's plan, with the president's free-token choice", () => {
    withRules(STANDARD, () => {
      const bare: MapGridResponse = { game_id: 1, tiles: [] };
      const state = stateWith([unindexed(NYC, "NYC", E11)]);
      const plan = planTokenUpgrade(bare, E11.q, E11.r, state.public_companies as unknown as StationTokenCompany[], 59, 0);
      expect(plan?.anyFree).toBe(true);
      const chosen = stationAnchorPlan(state, bare, { q: E11.q, r: E11.r, tileId: 59, orientation: 0 }, NYC, 1);
      expect(chosen.plan).toEqual(plan);
      expect(chosen.tokenCities).toEqual(tokenLandingsFor({ plan, actingCompanyId: NYC, chosenCity: 1 }));
      expect(chosen.tokenCities).toEqual([[NYC, 1]]);
      expect(chosen.refusal).toBeNull();
      // With no choice yet made the landing is omitted, exactly as the dispatch omits it.
      expect(stationAnchorPlan(state, bare, { q: E11.q, r: E11.r, tileId: 59, orientation: 0 }, NYC).tokenCities).toEqual([]);
      // Without a board the authority has no opinion (#757) and nothing to draw.
      expect(stationAnchorPlan(state, undefined, { q: E11.q, r: E11.r, tileId: 59, orientation: 0 }, NYC)).toEqual({
        plan: null,
        tokenCities: [],
        refusal: null,
      });
    });
  });
});

/* ---------------------------------------------------------------------------------------------------- */
/*  The composition itself: one answer, every asker                                                     */
/* ---------------------------------------------------------------------------------------------------- */

describe("the composition: the reducer applies a lay exactly when `layTileRefusal` answers null", () => {
  it("over a matrix of lays on the New York fixture, refusal <=> identity, and the grid follows", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0), tokened(NNH, "NNH", NY, 1)]);
      /* A geometry STUB, deliberately: the fixture grid is not a real board position, and this case is about
         the composition -- that the reducer and the grid follow ONE verdict whichever question refuses. The real
         geometry is exercised on the golden above (A/B) and in `stage92BoardAuthority.test.ts`. */
      const geometry = (_q: number, _r: number, tileId: number, _orientation: number) => tileId === 7;
      const ctx = { mapGrid: withSixtyTwo, layRefused: geometry };
      const cases: Array<Record<string, unknown>> = [];
      for (const orientation of [0, 1, 2, 3, 4, 5]) {
        for (const tokenCities of [undefined, [[NYC, 0], [NNH, 0]], [[NYC, 1], [NNH, 0]]]) {
          for (const protocol_id of [NYC, NNH]) {
            cases.push({ game_id: 1, protocol_id, q: NY.q, r: NY.r, tile_id: 883, orientation, ...(tokenCities ? { token_cities: tokenCities } : {}) });
          }
        }
      }
      cases.push({ game_id: 1, protocol_id: NYC, q: NY.q, r: NY.r, tile_id: 7, orientation: 0 }); // a yellow on brown: geometry refuses
      let refused = 0;
      let applied = 0;
      for (const lay of cases) {
        const msg = { LayTile: lay } as unknown as GameplayExecuteMsg;
        const verdict = layTileRefusal(state, msg, ctx);
        const after = applySandboxAction(state, msg, ctx);
        const grid = applySandboxLayTile(withSixtyTwo, NY.q, NY.r, lay.tile_id as number, lay.orientation as number, () => verdict !== null);
        expect({ lay, reducerApplied: after !== state, gridApplied: grid !== withSixtyTwo }).toEqual({
          lay,
          reducerApplied: verdict === null,
          gridApplied: verdict === null,
        });
        if (verdict === null) applied += 1;
        else refused += 1;
      }
      expect(applied).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    });
  });

  it("the identity question is the composition's first, so a lay by the corporation that is not operating is refused with #1510's sentence", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0), tokened(NNH, "NNH", NY, 1)]);
      const lay = { game_id: 1, protocol_id: NNH, q: NY.q, r: NY.r, tile_id: 883, orientation: 3, token_cities: [[NYC, 0], [NNH, 0]] as Array<[number, number]> };
      expect(layTileLegalityRefusal(state, lay, { mapGrid: withSixtyTwo })).toMatch(/Only the operating corporation lays track/);
    });
  });

  it("without a geometry provider the composition has no opinion on geometry, as the reducer always has (#757)", () => {
    withRules(PLUS, () => {
      const state = stateWith([tokened(NYC, "NYC", NY, 0)]);
      // A plain track tile on the printed OO city at E11: geometry refuses it, nothing else objects.
      const lay = { game_id: 1, protocol_id: NYC, q: E11.q, r: E11.r, tile_id: 7, orientation: 0 };
      expect(layTileLegalityRefusal(state, lay, { mapGrid: withSixtyTwo })).toBeNull();
      expect(
        layTileLegalityRefusal(state, lay, {
          mapGrid: withSixtyTwo,
          layRefused: (q, r, t, o) => boardLayRefused(withSixtyTwo, q, r, t, o, "Yellow"),
        }),
      ).toMatch(/cannot be laid/);
    });
  });
});
