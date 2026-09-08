/** @jest-environment node */
//
// Design note #1245 (harness): one consequence, one line -- three more places it was two.
//
// REPORTED: "[Buy Private] C&O bought 3. Delaware & Hudson from Host for $70." followed by
//           "Treasury — C&O spent $70 — treasury $1000 → $930." -- condense into one line.
//           "As a general rule, condense and remove any Activity Logs that start with '[thing] --'."
//           "[Station Tokens] Sandbox room" -- the drain's fallback label printed as the whole line, after #1244
//           took the shell's `PlaceHomeStation` branch (and its sentence) away.
// And §2.3 from the triage doc: the corporation-to-corporation train trade printed five lines, one of them
// false ("its 2-train was discarded to meet the new limit of 4" -- B&O SOLD it).

export {};

const { describeGameplayAction, sentenceStatesTreasury } =
  require("./actionLog") as typeof import("./actionLog");
const { describeFleetLosses } = require("./sandboxSession") as typeof import("./sandboxSession");
const { readStripped, sliceBetween } = require("./sourceScan") as typeof import("./sourceScan");
import type { GameStateResponse } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const PRR = 1;
const BO = 2;

const board = (over: {
  prr?: Partial<GameStateResponse["public_companies"][number]>;
  bo?: Partial<GameStateResponse["public_companies"][number]>;
} = {}): GameStateResponse =>
  ({
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    virtual_bank_vgp: "12000",
    private_companies: [{ private_id: 3, name: "Delaware & Hudson", owner: "p2", face_value: "70" }],
    current_round_type: "OperatingRound",
    operating_sub_phase: "BuyTrains",
    macro_round_number: 1,
    sub_round_index: 1,
    active_player_index: 0,
    active_operating_order: [PRR, BO],
    active_corporation_index: 0,
    consecutive_passes: 0,
    public_companies: [
      {
        company_id: PRR,
        ticker: "PRR",
        is_floated: true,
        president: "p1",
        par_value: "100",
        treasury: "920",
        last_route_revenue: "0",
        player_holdings: [{ player: "p1", percentage: 60 }],
        station_token_hexes: [[0, 0]],
        owned_trains: ["2"],
        ...over.prr,
      },
      {
        company_id: BO,
        ticker: "B&O",
        is_floated: true,
        president: "p2",
        par_value: "100",
        treasury: "640",
        last_route_revenue: "0",
        player_holdings: [{ player: "p2", percentage: 60 }],
        station_token_hexes: [[1, 1]],
        owned_trains: ["2", "2"],
        ...over.bo,
      },
    ],
  }) as unknown as GameStateResponse;

const context = (before: GameStateResponse, after?: GameStateResponse) => ({
  gameState: before,
  afterState: after,
  mapGrid: { game_id: 1, tiles: [] } as unknown as MapGridResponse,
  era: "Yellow" as const,
  labelForAddress: (address: string) => (address === "p2" ? "Host" : address),
});

describe("#1245: the private purchase states its own treasury movement", () => {
  it("appends the transition to the purchase sentence", () => {
    const line = describeGameplayAction(
      { BuyPrivateCompany: { protocol_id: PRR, private_id: 3, price: 70 } } as never,
      context(board(), board({ prr: { treasury: "850" } })) as never,
    );
    expect(line).toBe("PRR bought 3. Delaware & Hudson from Host for $70. Treasury $920 → $850.");
  });

  it("and so the diagnostic line goes quiet for it", () => {
    expect(sentenceStatesTreasury({ BuyPrivateCompany: {} } as never)).toBe(true);
    expect(sentenceStatesTreasury({ BuyTrainFromCorporation: {} } as never)).toBe(true);
  });
});

describe("#1245: the train trade is one sentence, and it is a purchase", () => {
  const trade = { BuyTrainFromCorporation: { buyer_protocol_id: PRR, seller_protocol_id: BO, model_type: "2", price: 80 } };

  it("names both treasuries in the buyer's line", () => {
    /* §2.3 wanted "PRR purchased a 2-train from B&O for $80." with the two `Treasury --` lines folded in. */
    const line = describeGameplayAction(
      trade as never,
      context(
        board(),
        board({ prr: { treasury: "840", owned_trains: ["2", "2"] }, bo: { treasury: "720", owned_trains: ["2"] } }),
      ) as never,
    );
    expect(line).toBe("PRR bought a 2-train from B&O for $80. PRR treasury $920 → $840; B&O treasury $640 → $720.");
    expect(line).not.toContain("offered");
  });

  it("states no movement when there is no settled state to read", () => {
    const line = describeGameplayAction(trade as never, context(board()) as never);
    expect(line).toBe("PRR bought a 2-train from B&O for $80.");
  });

  it("does not narrate the sold train as a discard", () => {
    /* The false line: `describeFleetLosses` diffs every fleet on every action, and a sale empties the
       seller's fleet by one exactly as a trim does -- #1099's shape (an expiry is not a discard). */
    const before = board();
    const after = board({ prr: { owned_trains: ["2", "2"] }, bo: { owned_trains: ["2"] } });
    expect(describeFleetLosses(before, after, trade)).toEqual([]);
    // The control: without the message the diff still reads as a loss, which is what the shell passes it for.
    expect(describeFleetLosses(before, after)).toHaveLength(1);
    const APP = readStripped("App.tsx");
    expect(APP).toContain("describeFleetLosses(before, after, msg)");
  });

  it("does not narrate the train the Yellow Sign took as a discard either", () => {
    /* Design note #1264: 22b's narration half. The Mark and the fog each remove one named train from one
       corporation, and the diff read that as a limit trim -- "gave up a train to the train limit" for a
       corporation that had just lost one. Same shape as the sale above, same fix. */
    const before = board({ bo: { owned_trains: ["2", "3"] } });
    const after = board({ bo: { owned_trains: ["3"] } });
    const mark = { YellowSignEvent: { protocol_id: BO, stage: "mark", model: "2", cash: "40" } };
    expect(describeFleetLosses(before, after, mark)).toEqual([]);
    // The control, as above.
    expect(describeFleetLosses(before, after)).toHaveLength(1);
    // A different corporation's event does not excuse this one's loss.
    const other = { YellowSignEvent: { protocol_id: PRR, stage: "mark", model: "2", cash: "40" } };
    expect(describeFleetLosses(before, after, other)).toHaveLength(1);
  });
});

describe("#1245: the home station has a sentence of its own again", () => {
  it("home and D&H placements", () => {
    const home = describeGameplayAction(
      { PlaceHomeStation: { company_id: PRR, q: 0, r: 0, kind: "home", city_index: null, hex_label: "H12" } } as never,
      context(board()) as never,
    );
    expect(home).toBe("PRR placed its home station token on H12.");
    const dh = describeGameplayAction(
      { PlaceHomeStation: { company_id: BO, q: 0, r: 0, kind: "dh", city_index: null, hex_label: "F16" } } as never,
      context(board()) as never,
    );
    expect(dh).toBe("B&O placed a free station token on F16 using the Delaware & Hudson.");
  });
});

describe("#1245: the category comes off every info line, in one place", () => {
  const APP = readStripped("App.tsx");

  it("logInfo stores the sentence as the label and nothing as the detail", () => {
    const body = sliceBetween(APP, "const logInfo = useCallback((", "  }, []);");
    expect(body).toContain('label: detail === "" ? label : detail,');
    expect(body).toContain('detail: "",');
    expect(body).not.toMatch(/\n\s*detail,\n/);
  });
});
