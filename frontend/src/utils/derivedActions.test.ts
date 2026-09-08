/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1202/1203 (harness): THE ACTIONS THE GAME SENDS
// ==================================================================
//
// The golden master cannot reach any of this. `JUNO-3XD` already CONTAINS its derived entries -- thirty-five
// of them, `derived: true`, appended by whichever client was acting at the time -- so replaying it exercises
// the applying half and says nothing whatever about the generating half.
//
// SO THE CASES ARE BUILT BY HAND, and they pin the three things that would be expensive to get wrong: that
// the decision matches the shell's, that a burst terminates, and that a restarted server does not re-send
// what the log already holds.

export {};

const { maxRouteRevenueFor, nextDerivedAction } =
  require("./derivedActions") as typeof import("./derivedActions");
const { sandboxScenarioState } = require("./sandboxState") as typeof import("./sandboxState");
const { MOCK_MAP_GRID } = require("./mockFixtures") as typeof import("./mockFixtures");
const { turnGuardKey } = require("./turnGuardKey") as typeof import("./turnGuardKey");

type State = import("./gameState").GameStateResponse;

/** A board mid-Operating-Round with one corporation acting. */
function operating(over: Partial<State> = {}): State {
  const seed = sandboxScenarioState("start", 0, "default");
  return {
    ...seed,
    current_round_type: "OperatingRound",
    macro_round_number: 4,
    sub_round_index: 1,
    active_operating_order: [1],
    active_corporation_index: 0,
    operating_sub_phase: "Hardware",
    ...over,
  };
}

function withCompany(state: State, patch: Record<string, unknown>): State {
  return {
    ...state,
    public_companies: state.public_companies.map((company) =>
      company.company_id === 1 ? { ...company, ...patch } : company,
    ),
  };
}

const ask = (state: State, emitted: ReadonlySet<string> = new Set()) =>
  nextDerivedAction({ state, mapGrid: MOCK_MAP_GRID, emitted });

describe("the game only acts inside an Operating Round", () => {
  it("says nothing in a Stock Round", () => {
    expect(ask(operating({ current_round_type: "StockRound" }))).toBeNull();
  });

  it("says nothing when the cursor cannot name a step", () => {
    /* #232, and `dividendGate`'s rule matched deliberately: an unknown cursor is allowed through rather than
       acted on. Emitting a skip against a step nobody can name would move a board on a missing field. */
    expect(ask(operating({ operating_sub_phase: undefined }))).toBeNull();
  });
});

describe("the train limit skip, #249/#703", () => {
  it("skips Buy Trains for a corporation at its limit", () => {
    const state = withCompany(operating(), {
      owned_trains: ["2", "2", "2", "2"],
    });
    const action = ask(state);
    expect(action?.reason).toBe("it is already at its train limit");
  });

  it("ends the turn rather than advancing, because Buy Trains is the last step", () => {
    /* #876: `nextSubPhase` returns `current` at the end of the list, so an advance there moves nothing --
       the guard marks the turn handled and the player is left on a turn that will not end. The only thing
       "skip" can mean on the last step is "this corporation is done". */
    const state = withCompany(operating(), { owned_trains: ["2", "2", "2", "2"] });
    expect(ask(state)?.kind).toBe("end-turn");
    expect(ask(state)?.msg).toHaveProperty("PassTurn");
  });

  it("never skips on an unknown fleet", () => {
    /* An unreadable roster is not a full one. Skipping on a guess takes a player's turn away, and #414
       settled which of the two available mistakes is the worse. */
    const state = withCompany(operating(), { owned_trains: undefined });
    expect(ask(state)).toBeNull();
  });

  it("leaves a corporation under the limit alone", () => {
    const state = withCompany(operating(), { owned_trains: ["2"] });
    expect(ask(state)).toBeNull();
  });
});

describe("the forced withhold, #292/#414", () => {
  it("declares $0 withheld rather than skipping the step", () => {
    /* 1830 HAS NO THIRD OPTION. A trainless corporation does not skip Dividends -- it declares nothing and
       the declaration is what steps the marker left. That is an action WITH a consequence, which is why
       #1057 still prints a line for it while an auto-skipped Run Routes earns none. */
    const state = withCompany(operating({ operating_sub_phase: "Dividends" }), {
      owned_trains: [],
    });
    const action = ask(state);
    expect(action?.kind).toBe("forced-withhold");
    expect(action?.msg).toMatchObject({
      DeclareDividends: { protocol_id: 1, revenue_amount: "0", distribute: false },
    });
  });

  it("forces the withhold when a corporation with trains ran nothing (design note #1275)", () => {
    /* JUNO-CV4 108-109: C&O had a 3-train and a station, skipped Routes, and Dividends waited on a hand-sent
       "$0 withheld". Can-earn is the Routes question; at Dividends with nothing run there is nothing to
       declare, so the declaration is forced. */
    const ran = withCompany(operating({ operating_sub_phase: "Dividends" }), {
      owned_trains: ["3"],
      station_token_hexes: [[0, 0]],
      routes_run_this_turn: 0,
      last_route_revenue: "0",
    });
    expect(ask(ran)?.kind).toBe("forced-withhold");
    expect(ask(ran)?.reason).toBe("it ran no routes this turn");
    /* #232: a log without the counter is not forced -- absent is "did not say", never zero. */
    const older = withCompany(operating({ operating_sub_phase: "Dividends" }), {
      owned_trains: ["3"],
      station_token_hexes: [[0, 0]],
      routes_run_this_turn: undefined,
      last_route_revenue: "0",
    });
    expect(ask(older)?.kind).not.toBe("forced-withhold");
    /* And a corporation that DID run is left to choose. */
    const chose = withCompany(operating({ operating_sub_phase: "Dividends" }), {
      owned_trains: ["3"],
      station_token_hexes: [[0, 0]],
      routes_run_this_turn: 1,
      last_route_revenue: "90",
    });
    expect(ask(chose)?.kind).not.toBe("forced-withhold");
  });

  it("claims the Dividends case before the skip can, and the order is load-bearing", () => {
    /* `autoSkipReason` returns null for Dividends-with-no-revenue precisely because the withhold above has
       already taken it. Reversing the two would skip the one step whose whole job is to move the price. */
    const state = withCompany(operating({ operating_sub_phase: "Dividends" }), {
      owned_trains: [],
    });
    expect(ask(state)?.kind).not.toBe("skip");
  });
});

describe("idempotency, #774's surviving half", () => {
  it("does not re-send an action whose key the caller already holds", () => {
    /* THE SHELL NEEDED `isMyTurn` BECAUSE EVERY BROWSER REACHED THE SAME CONCLUSION and each appended its
       own copy -- "a share price that moved two cells left rather than one". One writer cannot race itself,
       so that guard is gone. This is the other half, and it is for a different failure: a server restarted
       mid-turn, or rebuilding from a log, must not re-send what the log already holds. */
    const state = withCompany(operating(), { owned_trains: ["2", "2", "2", "2"] });
    const first = ask(state);
    expect(first).not.toBeNull();
    expect(ask(state, new Set([first!.key]))).toBeNull();
  });

  it("keys on the turn, so the guard re-arms next round", () => {
    /* #653: the turn is part of the key. #1145: it is built from `macro_round_number`, `sub_round_index` and
       `active_corporation_index`, so a REBUILD reproduces the same keys rather than continuing from wherever
       one process had got to -- which is what makes this survive a restart for free. */
    const state = withCompany(operating(), { owned_trains: ["2", "2", "2", "2"] });
    const spent = new Set([ask(state)!.key]);
    const nextRound = { ...state, macro_round_number: 5 };
    expect(ask(nextRound, spent)).not.toBeNull();
    expect(ask(state)!.key).toBe(turnGuardKey(state, 1, "Hardware"));
  });
});

describe("the Routes step, and the two ways of earning nothing", () => {
  it("holds the step open on a board that has not been laid", () => {
    /* ==================================================================
        THE SEARCH RUNS NOW, AND THIS CASE PASSES FOR A DIFFERENT REASON THAN IT USED TO
       ==================================================================
       While `maxRouteRevenueFor` was stubbed this asserted the stub. `assignRouteSet` is wired now, and on
       the empty starting grid it honestly returns 0 -- a corporation at H12 with a 2-train reaches no
       revenue centre because no track exists yet.
       AND THE STEP STAYS OPEN ANYWAY, which is the property worth pinning. `earnableRevenueVerdict` never
       consults the search here: it reads the unlaid board first and answers `{kind: "unknown", why: "the
       board has not loaded yet"}`, so `skipReasonFor` returns `null`.
       THAT IS #414's DISTINCTION EARNING ITS KEEP. "Could not tell" and "cannot earn" produce the same zero
       and must not produce the same decision, because the consumer of this answer takes somebody's turn
       away. A verdict that collapsed them would auto-skip every corporation on the opening board. */
    const state = withCompany(operating({ operating_sub_phase: "Routes" }), {
      owned_trains: ["2"],
      station_token_hexes: ["H12"],
    });
    expect(ask(state)).toBeNull();
  });

  it("reports zero for a corporation with an empty token list, and null for an absent one", () => {
    /* #484a: NO TOKEN IS A FACT, NOT AN ABSENCE OF ONE. An empty list is the board saying "nowhere to start";
       a missing list is the board not saying. `maxRouteRevenueFor` keeps them apart at its own boundary, so
       the distinction survives all the way down to the verdict rather than being flattened on arrival. */
    const state = operating({ operating_sub_phase: "Routes" });
    const empty = withCompany(state, { owned_trains: ["2"], station_token_hexes: [] });
    const absent = withCompany(state, { owned_trains: ["2"], station_token_hexes: undefined });
    expect(maxRouteRevenueFor(empty, 1, MOCK_MAP_GRID)).toBe(0);
    expect(maxRouteRevenueFor(absent, 1, MOCK_MAP_GRID)).toBeNull();
  });

  it("returns zero rather than null for a corporation with no trains", () => {
    /* A fleet of none is knowable, so it is answered rather than shrugged at -- and the shrug is reserved
       for the cases above, where the BOARD is what could not be read. */
    const state = withCompany(operating({ operating_sub_phase: "Routes" }), {
      owned_trains: [],
      station_token_hexes: ["H12"],
    });
    expect(maxRouteRevenueFor(state, 1, MOCK_MAP_GRID)).toBe(0);
  });
});

describe("the Tokens step is skipped when there is nowhere to place, #1237", () => {
  /* REPORTED FOUR TIMES AS "LAY TRACK DID NOT ADVANCE". The log of the fourth showed the truth: the lay moved the
     step to Tokens, the engine owed nothing, and forty-eight seconds later the player clicked Skip. The cause was
     `extraStationAvailable` defaulting to `true`, which `stationPlacementBlockReason` reads as "a placement
     exists" before it checks reachability -- so the server never skipped Tokens for anyone.
     THE TWO CASES BELOW ARE THE LINE #414 DREW: a corporation with a reachable free slot is waited for (skipping
     would take its move away); one with nowhere to place is moved on. Both are asserted, because a rule that
     skips everyone passes the second and breaks the game. */
  const { dhFreeStationAvailableFor, DH_PRIVATE_ID } = require("./dhPower") as typeof import("./dhPower");

  it("owes an advance for a corporation at Tokens whose network reaches no free slot", () => {
    /* Company 1 on the mock grid with its home token placed and no track laid: the only city it reaches is its
       own, already tokened. Nowhere to go. */
    const state = withCompany(operating({ operating_sub_phase: "Tokens" }), {
      is_floated: true,
      president: "p-a",
      treasury: "500",
      station_token_hexes: [[0, 0]],
      station_token_limit: 4,
    });
    const next = ask(state);
    expect(next).not.toBeNull();
    expect(next?.msg).toHaveProperty("AdvanceOperatingSubPhase");
  });

  it("does not skip when the caller says the D&H's free station is still available", () => {
    /* The explicit flag still wins -- a corporation whose only legal placement is the D&H's unconnected station
       must be waited for, which is the whole reason the parameter exists (#781). */
    const state = withCompany(operating({ operating_sub_phase: "Tokens" }), {
      is_floated: true,
      president: "p-a",
      treasury: "500",
      station_token_hexes: [[0, 0]],
      station_token_limit: 4,
    });
    const held = nextDerivedAction({ state, mapGrid: MOCK_MAP_GRID, emitted: new Set(), extraStationAvailable: true });
    expect(held).toBeNull();
  });

  describe("dhFreeStationAvailableFor, the shell's rule shared with the engine", () => {
    const privates = (owner: number | null, closed = false) => [
      { private_id: DH_PRIVATE_ID, owner_protocol_id: owner, closed },
    ];
    it("is available only to the corporation that owns the D&H, after its lay and before its token", () => {
      expect(dhFreeStationAvailableFor({ companyId: 1, privates: privates(1), usedAbilities: ["dh-tile"], dhHexBuilt: true })).toBe(true);
    });
    it("is not available to a rival, whatever the ability's state", () => {
      // #781: a rival mid-turn must not have its Tokens step held open by somebody else's private.
      expect(dhFreeStationAvailableFor({ companyId: 2, privates: privates(1), usedAbilities: ["dh-tile"], dhHexBuilt: true })).toBe(false);
    });
    it("is not available while the D&H is still a player's, unassigned to any corporation", () => {
      // `owner_protocol_id` is null until a corporation buys the private; a player cannot lend the power.
      expect(dhFreeStationAvailableFor({ companyId: 1, privates: privates(null), usedAbilities: ["dh-tile"], dhHexBuilt: true })).toBe(false);
    });
    it("is spent once the token has been placed, and gone if the private has closed", () => {
      expect(dhFreeStationAvailableFor({ companyId: 1, privates: privates(1), usedAbilities: ["dh-tile", "dh-token"], dhHexBuilt: true })).toBe(false);
      expect(dhFreeStationAvailableFor({ companyId: 1, privates: privates(1, true), usedAbilities: ["dh-tile"], dhHexBuilt: true })).toBe(false);
    });
    it("is not available before the D&H's own lay, which is the order the power comes in", () => {
      expect(dhFreeStationAvailableFor({ companyId: 1, privates: privates(1), usedAbilities: [], dhHexBuilt: false })).toBe(false);
    });
  });
});
