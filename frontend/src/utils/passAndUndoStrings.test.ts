// frontend/src/utils/passAndUndoStrings.test.ts
//
// ==================================================================
//  DESIGN NOTE 478 (harness): WHO PASSED, AND ON WHAT
// ==================================================================
//
// The reported line was "[Player] passed the turn" in an Operating Round.
// Two faults in one sentence, and they need separate tests because a fix
// for either one alone still leaves a wrong line:
//
//   THE WRONG ACTOR. An Operating Round is corporation-driven. Naming the
//   president is not merely a style choice -- in a hotseat where one player
//   presides over three companies it does not say which one passed. The
//   test for this asserts the ticker appears AND the president's name does
//   not, because a sentence containing both would read as fixed and still
//   be ambiguous.
//
//   THE MISSING OBJECT. "Passed the turn" is true of every pass ever made,
//   so a column of them is a column of identical lines.
//
// THE STOCK ROUND MUST NOT REGRESS. `PassTurn` outside an Operating Round
// really is a seated player passing, and there is no corporation to name.
// That case is tested explicitly, because "name the corporation" applied
// uniformly would print a corporation into a round that has none.
//
// The undo half is tested at `App.tsx`'s composition rather than here --
// what this file can pin is that the ONLINE description does not invent an
// action it has no way to know (design note #479).

import { actingActor, describeGameplayAction, type ActionLogContext } from "./actionLog";
import type { GameStateResponse, PublicCompanyState } from "./gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

const ALICE = "juno1alice";
const BOB = "juno1bob";

function company(
  over: Partial<PublicCompanyState> & Pick<PublicCompanyState, "company_id" | "ticker">,
): PublicCompanyState {
  return {
    is_floated: true,
    treasury: "500",
    total_shares_issued: 10,
    par_value: "100",
    president: ALICE,
    ipo_pool_percentage: 0,
    bank_pool_percentage: 0,
    player_holdings: [],
    home_hex_label: null,
    station_token_hexes: [],
    station_token_limit: 4,
    owned_trains: [],
    last_route_revenue: "0",
    ...over,
  };
}

function state(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return {
    game_id: 1,
    creator: ALICE,
    is_active: true,
    total_juno_pool: "0",
    virtual_bank_vgp: "12000",
    virtual_bank_start: "12000",
    max_players: 2,
    player_addresses: [ALICE, BOB],
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [1, 4],
    active_corporation_index: 0,
    current_round_type: "OperatingRound",
    macro_round_number: 2,
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    player_cash: [
      { player: ALICE, cash_vgp: "400" },
      { player: BOB, cash_vgp: "400" },
    ],
    public_companies: [
      company({ company_id: 1, ticker: "PRR" }),
      company({ company_id: 4, ticker: "B&O", president: BOB }),
    ],
    private_companies: [],
    ...over,
  };
}

const EMPTY_GRID = { hexes: [] } as unknown as MapGridResponse;

function context(over: Partial<ActionLogContext> = {}): ActionLogContext {
  return {
    gameState: state(),
    mapGrid: EMPTY_GRID,
    era: "Yellow",
    labelForAddress: (address: string) => (address === ALICE ? "Alice" : "Bob"),
    orSubPhase: "Track",
    ...over,
  };
}

const PASS = { PassTurn: { game_id: 1 } } as const;
const SKIP = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 1 } } as const;
const UNDO = { UndoLastAction: { game_id: 1 } } as const;

describe("passing in an Operating Round", () => {
  it("reads exactly as the requirement's worked example", () => {
    expect(describeGameplayAction(PASS, context())).toBe("PRR passed Lay Track.");
  });

  it("names the corporation and NOT its president", () => {
    // The ambiguity the report is really about: Alice presides over more
    // than one company, so "Alice passed" does not say which passed.
    const line = describeGameplayAction(PASS, context()) ?? "";
    expect(line).toContain("PRR");
    expect(line).not.toContain("Alice");
  });

  it("follows the operating queue rather than the seat pointer", () => {
    // `active_player_index` still points at seat 0 here. The corporation up
    // is the second in the queue, presided over by somebody else entirely --
    // the exact case where reading the seat gives the wrong name.
    const line = describeGameplayAction(
      PASS,
      context({ gameState: state({ active_corporation_index: 1 }) }),
    );
    expect(line).toBe("B&O passed Lay Track.");
  });

  it("names the step the cursor is actually on", () => {
    // Not a fixed word. Each step has to reach the sentence.
    const steps: Array<[ActionLogContext["orSubPhase"], string]> = [
      ["BuyPrivate", "PRR passed Buy Private."],
      ["Track", "PRR passed Lay Track."],
      ["Tokens", "PRR passed Station Tokens."],
      ["Dividends", "PRR passed Dividends."],
    ];
    for (const [step, expected] of steps) {
      expect(describeGameplayAction(PASS, context({ orSubPhase: step }))).toBe(expected);
    }
  });

  it("uses the stepper's own verb-led label, not the enum name", () => {
    // "Lay Track", not "Track" -- and the value comes from the strip's
    // table, so the log and the strip cannot name one step two ways.
    expect(describeGameplayAction(PASS, context())).not.toContain("passed Track");
  });

  it("falls back to a shorter sentence when no step is known", () => {
    // A caller with no cursor gets less, not a guessed step. Still the
    // corporation, because that half is derivable from state alone.
    expect(describeGameplayAction(PASS, context({ orSubPhase: null }))).toBe(
      "PRR passed its turn.",
    );
  });
});

describe("passing outside an Operating Round", () => {
  it("still names the seated player", () => {
    // There is no corporation to name and no sub-phase to be on. Applying
    // the Operating Round wording uniformly would print a corporation into
    // a round that has none.
    const line = describeGameplayAction(
      PASS,
      context({ gameState: state({ current_round_type: "StockRound" }) }),
    );
    expect(line).toBe("Alice passed the turn.");
  });

  it("does not name a corporation in a Stock Round", () => {
    const line =
      describeGameplayAction(
        PASS,
        context({ gameState: state({ current_round_type: "StockRound" }) }),
      ) ?? "";
    expect(line).not.toContain("PRR");
    expect(line).not.toContain("B&O");
  });
});

describe("skipping a sub-phase", () => {
  it("says which step was skipped", () => {
    // It was "PRR skipped a step" -- the one message whose entire content
    // is WHICH step, with that part left out.
    expect(describeGameplayAction(SKIP, context({ orSubPhase: "Tokens" }))).toBe(
      "PRR passed Station Tokens.",
    );
  });

  it("names the corporation the message carries, not the queue cursor", () => {
    // `AdvanceOperatingSubPhase` has a `protocol_id` of its own and it is
    // the authority here.
    const line = describeGameplayAction(
      { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 4 } },
      context(),
    );
    expect(line).toBe("B&O passed Lay Track.");
  });

  it("degrades to the old wording rather than inventing a step", () => {
    expect(describeGameplayAction(SKIP, context({ orSubPhase: null }))).toBe(
      "PRR skipped a step.",
    );
  });
});

describe("undo, described online", () => {
  it("names the actor", () => {
    expect(describeGameplayAction(UNDO, context())).toBe("PRR reverted their last action.");
  });

  it("does not claim to know WHICH action", () => {
    /* Design note #479: the sandbox names it from the snapshot stack. A
       live chain resolves undo itself, a block or two later, so anything
       specific said here would be a guess printed as a fact. The sandbox's
       richer sentence is composed in `App.tsx`, not here. */
    const line = describeGameplayAction(UNDO, context()) ?? "";
    expect(line).not.toContain("Lay Track");
    expect(line).not.toContain(":");
  });
});

describe("actingActor", () => {
  it("returns the corporation up in an Operating Round", () => {
    expect(actingActor(context())).toBe("PRR");
  });

  it("returns the seated player everywhere else", () => {
    expect(
      actingActor(context({ gameState: state({ current_round_type: "StockRound" }) })),
    ).toBe("Alice");
  });

  it("falls back to the seat when the queue is empty", () => {
    // An Operating Round whose queue has not been built yet. Naming nobody
    // would be worse than naming the seat.
    expect(actingActor(context({ gameState: state({ active_operating_order: [] }) }))).toBe(
      "Alice",
    );
  });

  it("never returns a bare id", () => {
    // "#4 passed Lay Track" is the same failure the whole log was written
    // to remove.
    expect(actingActor(context())).not.toMatch(/^#?\d+$/);
  });
});
