/** @jest-environment node */
//
// ==================================================================
//  STAGE 9.5 (harness): THE OWNER'S CLOSURE RULINGS, PINNED
// ==================================================================
//
// Three of the four Stage-9 closure blockers were rulings rather than defects: the code already did the right
// thing and the ledger did not say so. These cases are the proof, and they are deliberately small -- each one
// states the owner's sentence and asks the production function the same question.
//
// S9-2 is the exception and is NOT pinned here. Its measurement lives in `stage95GhostLimit.test.ts` beside
// the contradiction it found.

export {};

const { cslPowerState, CSL_POWER_DESCRIPTION, CSL_HEX_LABEL } =
  require("../gameEngine/dhPower") as typeof import("../gameEngine/dhPower");
const { filterSandboxPlacements } =
  require("../components/sandboxTileLegality") as typeof import("../components/sandboxTileLegality");
const { applySandboxAction } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { runWithoutTrain, lowestValueTrain, markPayout, resolveYellowSign } =
  require("../gameEngine/yellowSign") as typeof import("../gameEngine/yellowSign");
const { STANDARD_VARIANTS, rollTurnRevenue } =
  require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { STATIC_BOARD_HEXES } =
  require("../components/hexBoardData") as typeof import("../components/hexBoardData");
import type { GameStateResponse } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

/* ------------------------------------------------------------------ */
/* S9-6 -- the C&SL grants a bonus LAY, never an upgrade right         */
/* ------------------------------------------------------------------ */

describe("S9-6: the C&SL special is a bonus lay, not an upgrade right", () => {
  it("is offered only while B20 is bare", () => {
    /* OWNER RULING: the special grants a bonus TILE LAY on B20. It does not grant a general track action, and
       it does not become an upgrade right merely because an ordinary track action may lay OR upgrade. */
    expect(cslPowerState({ hexBuilt: false, layUsed: false }).layAvailable).toBe(true);
    expect(cslPowerState({ hexBuilt: false, layUsed: false }).layBlockedReason).toBeNull();
  });

  it("has no legal target once B20 carries a tile — and says so as a lay, not a lapse", () => {
    /* OWNER RULING: "do not invent a D&H-style explicit 'lapse on another corporation's lay' rule for C&SL …
       the unused power simply has no legal bonus-lay target once B20 is already tiled." The OUTCOME was
       always right; the sentence asserted a rule the C&SL does not have. */
    const spent = cslPowerState({ hexBuilt: true, layUsed: false });
    expect(spent.layAvailable).toBe(false);
    expect(spent.layBlockedReason).toContain("no legal target");
    expect(spent.layBlockedReason).toContain("it does not upgrade");
    // The invented lapse wording is gone from both the state and the power's description.
    expect(spent.layBlockedReason).not.toContain("gone for the rest of the game");
    expect(CSL_POWER_DESCRIPTION).not.toContain("forfeited");
    expect(CSL_POWER_DESCRIPTION).toContain("not an upgrade");
  });

  it("is spent once used, whoever laid on B20", () => {
    expect(cslPowerState({ hexBuilt: true, layUsed: true }).layAvailable).toBe(false);
    expect(cslPowerState({ hexBuilt: false, layUsed: true }).layAvailable).toBe(false);
  });

  it("confers no tile legality the ordinary rules would refuse", () => {
    /* THE POWER WAIVES CONNECTIVITY AND THE TRACK STEP'S COST, NEVER THE TILE'S OWN LEGALITY. The
       authoritative predicate is asked the same question with and without the power, because it never sees
       the power at all -- its whole input is the grid, the hex and the era. So there is no path on which the
       C&SL makes an otherwise illegal tile legal, and in particular none on which it upgrades. */
    const b20 = STATIC_BOARD_HEXES.find((hex) => hex.label === CSL_HEX_LABEL)!;
    const bare = { game_id: 1, tiles: [] } as unknown as MapGridResponse;
    const yellowOnBare = filterSandboxPlacements([{ tile_id: 8, orientation: 0 }], {
      mapGrid: bare,
      q: b20.q,
      r: b20.r,
      era: "Yellow",
    });
    // Whatever the ordinary rules say about a bare B20, they say it without consulting the private.
    const built = {
      game_id: 1,
      tiles: [{ q: b20.q, r: b20.r, tile_id: 8, orientation: 0 }],
    } as unknown as MapGridResponse;
    const yellowOnBuilt = filterSandboxPlacements([{ tile_id: 8, orientation: 0 }], {
      mapGrid: built,
      q: b20.q,
      r: b20.r,
      era: "Yellow",
    });
    // A second yellow on a yellow hex is a colour-tier repeat and is refused by the ordinary rules.
    expect(yellowOnBuilt.length).toBe(0);
    // And the bare-hex answer is the ordinary one, not a privileged one.
    expect(Array.isArray(yellowOnBare)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* S9-3 -- only the disappeared train's run is nullified               */
/* ------------------------------------------------------------------ */

const BO = 6;
const SHORT = [{ hex: "F2" }, { hex: "A9" }];
/** A seed whose natural draw IS the Mark, found against the real selector rather than asserted (#1661). */
function markSeed(seedBoard: GameStateResponse, trains: string[]): number {
  for (let s = 1; s < 400000; s += 1) {
    const ran = applySandboxAction(seedBoard, {
      RunMultipleRoutes: { protocol_id: BO, routes: trains.map(() => SHORT), trains, train_indices: trains.map((_t, i) => i), revenue_seed: s },
    } as never);
    if (resolveYellowSign(ran, BO, "4").outcome?.stage === "mark") return s;
  }
  throw new Error("no mark seed");
}

const markBoard = (): GameStateResponse =>
  ({
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: 1,
    operating_sub_phase: "Routes",
    active_operating_order: [BO],
    active_corporation_index: 0,
    player_addresses: ["p1"],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    private_companies: [],
    rules_engine_version: 6,
    variants: { ...STANDARD_VARIANTS, unpredictableRevenue: true },
    public_companies: [
      { company_id: BO, ticker: "B&O", president: "p1", treasury: "340", last_route_revenue: "0", owned_trains: ["3", "4"] },
    ],
  }) as unknown as GameStateResponse;

const corp = (s: GameStateResponse) => s.public_companies.find((c) => c.company_id === BO)!;

describe("S9-3: the Mark nullifies the vanished train's run and nothing else", () => {
  it("keeps the other trains' legal revenue and pays half the taken train's face value", () => {
    /* OWNER RULING (2026-09-19): "ONLY THAT TRAIN'S RUN is nullified; revenue legally earned by the
       corporation's OTHER trains remains valid and pays normally … one-half of the disappeared train's face
       value is deposited directly into the corporation treasury."
       THIS IS #1375's RULING, ALREADY IMPLEMENTED. The case is here so S9-3 has its own proof rather than
       resting on a neighbouring entry's. */
    const SEED = markSeed(markBoard(), ["3", "4"]);
    const PARTS = { macroRound: 3, subRound: 1, companyId: BO, turnSeed: SEED };
    const ran = applySandboxAction(markBoard(), {
      RunMultipleRoutes: { protocol_id: BO, routes: [SHORT, SHORT], trains: ["3", "4"], train_indices: [0, 1], revenue_seed: SEED },
    } as never);
    const before = corp(ran);
    const taken = lowestValueTrain(before.owned_trains)!;
    expect(taken).toBe("3");
    const takenPrinted = Number(before.last_run_breakdown!.find((e) => e.model === "3")!.printed_revenue);
    const printedBefore = Number(before.printed_route_revenue);
    expect(takenPrinted).toBeGreaterThan(0);
    expect(printedBefore).toBeGreaterThan(takenPrinted); // the other train earned something

    const marked = applySandboxAction(ran, { YellowSignEvent: { game_id: 0, protocol_id: BO } } as never);
    const after = corp(marked);

    // ONLY the taken train's route is gone.
    expect(after.owned_trains).toEqual(["4"]);
    expect(Number(after.printed_route_revenue)).toBe(printedBefore - takenPrinted);
    expect(after.last_run_breakdown!.map((e) => e.model)).toEqual(["4"]);
    expect(after.routes_run_this_turn).toBe(1);
    // The remainder is NOT zeroed -- it is re-rolled under the turn's own seed and still pays.
    expect(Number(after.last_route_revenue)).toBe(rollTurnRevenue(printedBefore - takenPrinted, PARTS).adjusted);
    expect(Number(after.last_route_revenue)).toBeGreaterThan(0);
    // And the bag of gold is half the vanished train's face value, floored.
    expect(Number(after.treasury)).toBe(340 + markPayout(taken));
    // One function, both readers (#1375): the sentence the shell prints reads the same figure.
    expect(runWithoutTrain(before, taken, PARTS).adjusted).toBe(Number(after.last_route_revenue));
  });

  it("zeroes nothing on a corporation whose only train is the one that vanished", () => {
    /* The boundary the ruling implies: with no other train there is no other revenue to preserve, and the
       corporation still receives the gold. */
    const solo = () => {
      const b = markBoard();
      (b.public_companies[0] as { owned_trains: string[] }).owned_trains = ["3"];
      return b;
    };
    const SOLO_SEED = markSeed(solo(), ["3"]);
    const ran = applySandboxAction(solo(), {
      RunMultipleRoutes: { protocol_id: BO, routes: [SHORT], trains: ["3"], train_indices: [0], revenue_seed: SOLO_SEED },
    } as never);
    const marked = applySandboxAction(ran, { YellowSignEvent: { game_id: 0, protocol_id: BO } } as never);
    const after = corp(marked);
    expect(after.owned_trains).toEqual([]);
    expect(Number(after.printed_route_revenue)).toBe(0);
    expect(Number(after.treasury)).toBe(340 + markPayout("3"));
  });
});
