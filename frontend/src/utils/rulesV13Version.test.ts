/** @jest-environment node */
// frontend/src/utils/rulesV13Version.test.ts
//
// ==================================================================
//  PHASE 3 W3-K (RULES ENGINE v13): REPLAY AND VERSION ISOLATION
// ==================================================================
//
// One bump (12 -> 13), one changelog row; the live list is [13] (owner policy: pinned v12 rooms are drained or abandoned
// before v13 deploys -- no [12, 13] dual support); settlement stays [10, 11, 12] (v13 certification PENDING). The v13
// corrections are switched by rules revision 2, which every hosted v13 deal is stamped with -- so:
//   * a v13 board uses the new rules;
//   * a pinned v12 room is refused before a single entry is applied (never reinterpreted);
//   * unpinned development history keeps its legacy interpretation (revision 0 / 1);
//   * the three new messages cannot land on a board of an older revision;
//   * the revision-2 Stock Round and funding state is never written on, nor read from, legacy data.
// The development corpus itself (owner-local `server/data` and the `sandbox-log-JUNO-*` exports) replays unchanged:
// the corpus closures (`stage10Closure`, `gentleRustClosure`, `unpredictableRevenueClosure`, `trainDiscard`,
// `replayJuno3XD`) are the measurement, and pass with those files present.

export {};

const {
  RULES_ENGINE_VERSION,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  RULES_ENGINE_CHANGELOG,
  RULES_ENGINE_VERSION_FIELD,
  replayCompatibility,
  replayRefusal,
  SERVER_REPLAY_POLICY,
} = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS } = require("../gameEngine/settlementAppraisal") as typeof import("../gameEngine/settlementAppraisal");
const { CURRENT_RULES_REVISION, STANDARD_VARIANTS, automaticEmergencyFundingInForce, resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { applySandboxAction } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { RoomEngine } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxWaterfallState, sandboxScenarioState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const { dealFormatOf } = require("../gameEngine/compat/sessionContinuation") as typeof import("../gameEngine/compat/sessionContinuation");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { emergencyFundingFor, retiredDeclarationRefusal } = require("../gameEngine/emergencyFunding") as typeof import("../gameEngine/emergencyFunding");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;
type MapGridResponse = import("../components/hexContractTypes").MapGridResponse;
type ServerLogEntry = import("./roomSession").ServerLogEntry;

describe("one bump, one row, the live list and the settlement axis", () => {
  it("RULES_ENGINE_VERSION is 13, the live list is exactly [13], and the v13 row is the last and only new one", () => {
    expect(RULES_ENGINE_VERSION).toBe(13);
    expect([...SUPPORTED_RULES_ENGINE_VERSIONS]).toEqual([13]);
    expect(RULES_ENGINE_CHANGELOG.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const row = RULES_ENGINE_CHANGELOG[RULES_ENGINE_CHANGELOG.length - 1].note;
    for (const named of ["OD-2", "SBS-3", "SBS-4", "OD-4", "EmergencySellPortfolio", "ForgoTrainTrade", "ForgoPrivateFunding", "DeclareBankruptcy", "revision 2"]) {
      expect([named, row.includes(named)]).toEqual([named, true]);
    }
    expect(row).toMatch(/NOT .*V-6\.3/);
    expect(row).toMatch(/SETTLEMENT IS A SEPARATE AXIS/);
  });

  it("settlement stays certified for [10, 11, 12] exactly -- 13 is NOT certified by the rules landing", () => {
    expect([...SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS]).toEqual([10, 11, 12]);
    expect(SETTLEMENT_CERTIFIED_RULES_ENGINE_VERSIONS.includes(RULES_ENGINE_VERSION)).toBe(false);
  });

  it("v13 deals rules revision 2, and a v12-era build reads a revision-2 deal as a NEWER format (never misreads it)", () => {
    expect(CURRENT_RULES_REVISION).toBe(2);
    expect(STANDARD_VARIANTS.rules).toBe(2);
    expect(dealFormatOf({ variants: { rules: 2 } })).toBe("current");
    expect(dealFormatOf({ variants: { rules: 3 } })).toBe("newer");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const service = fs.readFileSync(path.join(__dirname, "..", "..", "..", "server", "src", "rooms", "roomService.ts"), "utf8");
    expect(service).toContain("variants: { ...plan.variants, rules: CURRENT_RULES_REVISION },"); // the server stamps every hosted deal
  });
});

describe("a pinned v12 room is unsupported after the bump -- refused, never reinterpreted", () => {
  const seedOf = () => ({
    state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
  });

  it("a fresh deal is stamped 13; the same log re-pinned to 12 is held before the first apply, under the server policy", () => {
    const fresh = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "d" });
    const deal = { SetupGame: { players: [{ id: "p1", nickname: "A" }, { id: "p2", nickname: "B" }], variants: { ...STANDARD_VARIANTS }, build: "b" } };
    expect(fresh.submit({ actor: "p1", build: "b", msg: deal as never, baseIndex: -1 }).kind).toBe("applied");
    expect(fresh.rulesEngineVersion()).toBe(13);
    const atTwelve = fresh.entries.map((row) => {
      const parsed = JSON.parse(row.payload) as { SetupGame?: Record<string, unknown> };
      return parsed.SetupGame ? { ...row, payload: JSON.stringify({ ...parsed, SetupGame: { ...parsed.SetupGame, [RULES_ENGINE_VERSION_FIELD]: 12 } }) } : { ...row };
    });
    expect(replayRefusal(replayCompatibility(atTwelve), SERVER_REPLAY_POLICY)).toContain("rules engine version 12");
    const applySpy = jest.spyOn(RoomEngine.prototype, "apply");
    try {
      const old = new RoomSession({ providers: sandboxReplayProviders(), seed: seedOf(), build: "b", mintId: () => "x" });
      old.restore(atTwelve as ServerLogEntry[]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(old.incompatible?.compatibility).toEqual({ kind: "incompatible", version: 12, supported: [13] });
    } finally {
      applySpy.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The new messages cannot land on an older revision                   */
/* ------------------------------------------------------------------ */

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
const CORRIDOR = { game_id: 1, tiles: [{ q: H16.q, r: H16.r, tile_id: 57, orientation: 2 }, { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 }] } as unknown as MapGridResponse;

/** An emergency obligation (C&O trainless at Buy Trains, $50 short; P1 holds NYC 10% at $100) at the given revision. */
function owed(rules: number, pin: number | null): GameStateResponse {
  return {
    player_addresses: ["p1", "p2", "p3"],
    player_cash: [{ player: "p1", cash_vgp: "0" }, { player: "p2", cash_vgp: "300" }, { player: "p3", cash_vgp: "300" }],
    virtual_bank_vgp: "10000",
    variants: { rules },
    ...(pin === null ? {} : { rules_engine_version: pin }),
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: [5, 2],
    active_corporation_index: 0,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    market_positions: { 5: { price: 90, x: 6, y: 6, enteredAt: 1 }, 2: { price: 100, x: 8, y: 6, enteredAt: 2 } },
    public_companies: [
      { company_id: 5, ticker: "C&O", is_floated: true, president: "p1", par_value: "90", ipo_pool_percentage: 0, bank_pool_percentage: 0, treasury: "30", owned_trains: [], player_holdings: [{ player: "p1", percentage: 20 }, { player: "p2", percentage: 20 }], station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6" },
      { company_id: 2, ticker: "NYC", is_floated: true, president: "p2", par_value: "100", ipo_pool_percentage: 0, bank_pool_percentage: 0, treasury: "500", owned_trains: [], player_holdings: [{ player: "p2", percentage: 30 }, { player: "p1", percentage: 10 }], station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6" },
    ],
  } as unknown as GameStateResponse;
}

describe("new messages cannot appear on an incompatible old board; legacy behaviour is kept", () => {
  const NEW = [
    { ForgoTrainTrade: { game_id: 1 } },
    { ForgoPrivateFunding: { game_id: 1 } },
    { EmergencySellPortfolio: { game_id: 1, sales: [{ protocol_id: 2, percentage: 10 }] } },
  ];
  const apply = (state: GameStateResponse, msg: unknown) => applySandboxAction(state, msg as never, { actor: "p1", mapGrid: CORRIDOR });

  it("on a revision-1 board (pinned or not) each new message is refused at the reducer and at ingress -- and the default arm's seat advance never meets it", () => {
    for (const board of [owed(1, 12), owed(1, null), owed(0, null)]) {
      for (const msg of NEW) {
        const after = apply(board, msg);
        expect(stateDigest(after)).toBe(stateDigest(board));
        expect(after.active_operating_order[after.active_corporation_index]).toBe(5);
        expect(turnRefusal({ state: board, waterfall: null, actor: "p1", msg: msg as never, mapGrid: CORRIDOR })).toContain("rules revision 2");
      }
    }
  });

  it("on a revision-1 board the v12 emergency flow is intact: the single forced SellStock, the president's EmergencyBuyHardware, DeclareBankruptcy's rules", () => {
    const legacy = owed(1, 12);
    expect(automaticEmergencyFundingInForce(resolveVariants(legacy.variants))).toBe(false);
    const funding = emergencyFundingFor(legacy, CORRIDOR)!;
    expect(funding.automatic).toBeUndefined();
    expect(funding.legalSales.map((sale) => [sale.ticker, sale.bundles])).toEqual([["NYC", [10]]]);
    expect(retiredDeclarationRefusal(legacy)).toBeNull();
    const sold = apply(legacy, { SellStock: { game_id: 1, protocol_id: 2, percentage: 10 } });
    expect(Number(sold.player_cash[0].cash_vgp)).toBe(100);
    const bought = apply(sold, { EmergencyBuyHardware: { game_id: 1, protocol_id: 5 } });
    expect(bought.public_companies[0].owned_trains).toEqual(["2"]);
    // The same board at revision 2: the single sale is refused and the portfolio is the way.
    const v13 = owed(2, 13);
    expect(stateDigest(apply(v13, { SellStock: { game_id: 1, protocol_id: 2, percentage: 10 } }))).toBe(stateDigest(v13));
    expect(Number(apply(v13, NEW[2]).player_cash[0].cash_vgp)).toBe(100);
  });

  it("revision-specific state is absent on legacy data: a revision-1 Stock Round turn writes no continuation, and a refusal writes no mark", () => {
    const sr = {
      ...owed(1, 12),
      current_round_type: "StockRound",
      operating_sub_phase: undefined,
      market_positions: { 5: { price: 30, x: 0, y: 9, enteredAt: 1 }, 2: { price: 100, x: 8, y: 6, enteredAt: 2 } },
      public_companies: owed(1, 12).public_companies.map((company) => (company.company_id === 5 ? { ...company, bank_pool_percentage: 30 } : company)),
    } as unknown as GameStateResponse;
    const bought = applySandboxAction(sr, { BuyStock: { game_id: 1, protocol_id: 5, source: "Bank" } } as never, { actor: "p1", marketZoneFor: () => "Brown" });
    expect(Object.prototype.hasOwnProperty.call(bought, "brown_pool_continuation_company")).toBe(false);
    const refused = apply(owed(1, 12), NEW[0]);
    expect(Object.prototype.hasOwnProperty.call(refused, "emergency_funding_marks")).toBe(false);
  });
});
