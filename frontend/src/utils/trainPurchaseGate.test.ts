/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1019 (harness): THE REPORTED BOARD, DRIVEN
// ==================================================================
//
// A state-corruption report gets a state-corruption test. Every case below runs the REAL reducer over a state
// shaped like the one in the log -- NNH operating, $340 in the treasury, a D-train at $1100 in the depot --
// and asserts on what the board looks like afterwards. A source scan asserting "there is a funds check" would
// pass against a check in an unreachable arm, which is the shape (#788) this project keeps producing.
//
// THE THREE CLAIMS, EACH TESTED AS A BOARD RATHER THAN AS A LINE:
//   the treasury does not move; the fleet does not grow; and the message reads as REFUSED rather than as a
//   success, which #778 derives from object identity and is therefore checkable exactly.

export {};

const { applySandboxAction } =
  require("./sandboxSession") as typeof import("./sandboxSession");
const { trainPurchaseRefusal } =
  require("./trainPurchaseGate") as typeof import("./trainPurchaseGate");
const { actionWasRefused, refusalReasonFor } =
  require("./refusedAction") as typeof import("./refusedAction");
const { depotInventory } = require("./gamePhase") as typeof import("./gamePhase");
const { readStripped, sliceBetween } =
  require("./sourceScan") as typeof import("./sourceScan");

type State = Parameters<typeof trainPurchaseRefusal>[0];

const NNH = 7;
const RIVAL = 4;

/** The board from the report: NNH operating, poor, and holding trains that put the depot on its last tier.
 *  `owned_trains` across the two corporations is what `depotInventory` reads to decide which tier is for
 *  sale, so the fixture buys its D-train by owning everything cheaper rather than by asserting a price. */
function board(overrides: Record<string, unknown> = {}): State {
  return {
    game_id: 1,
    current_round_type: "OperatingRound",
    operating_sub_phase: "Hardware",
    macro_round_number: 9,
    sub_round_index: 1,
    active_operating_order: [NNH, RIVAL],
    active_corporation_index: 0,
    active_player_index: 0,
    player_addresses: ["p1", "p2"],
    player_cash: [
      { player: "p1", cash_vgp: "500" },
      { player: "p2", cash_vgp: "500" },
    ],
    bank_cash_vgp: "8000",
    private_companies: [],
    public_companies: [
      {
        company_id: NNH,
        ticker: "NNH",
        president: "p1",
        treasury: "340",
        owned_trains: ["6"],
        station_token_hexes: [[6, 6]],
        station_token_limit: 4,
        player_holdings: [{ player: "p1", percentage: 60 }],
        is_floated: true,
      },
      {
        company_id: RIVAL,
        ticker: "B&O",
        president: "p2",
        treasury: "2000",
        owned_trains: ["2", "2", "3", "3", "4", "4", "5", "5", "6"],
        station_token_hexes: [[3, 8]],
        station_token_limit: 4,
        player_holdings: [{ player: "p2", percentage: 60 }],
        is_floated: true,
      },
    ],
    ...overrides,
  } as unknown as State;
}

const BUY = (companyId: number) => ({
  BuyHardwareFromPool: { game_id: 1, protocol_id: companyId },
});

const treasuryOf = (state: State, companyId: number) =>
  Number(
    (state as unknown as { public_companies: Array<{ company_id: number; treasury: string }> })
      .public_companies.find((entry) => entry.company_id === companyId)?.treasury,
  );

const fleetOf = (state: State, companyId: number) =>
  (state as unknown as { public_companies: Array<{ company_id: number; owned_trains: string[] }> })
    .public_companies.find((entry) => entry.company_id === companyId)?.owned_trains ?? [];

describe("the fixture really is the reported board", () => {
  /* THE ASSUMPTIONS, FIRST. Every refusal below is vacuous if the depot is not actually offering a train
     NNH cannot afford -- and a vacuous pass is the failure mode this project keeps finding. */
  it("offers a train that costs more than NNH holds", () => {
    const tier = depotInventory(board() as never).find(
      (row) => row.remaining === null || row.remaining > 0,
    );
    expect(tier).toBeDefined();
    expect(tier!.cost).toBeGreaterThan(340);
    expect(treasuryOf(board(), NNH)).toBe(340);
  });

  it("has NNH as the operating corporation", () => {
    // The refusal in the log claimed otherwise; the fixture must not reproduce that confusion by accident.
    expect(trainPurchaseRefusal(board(), NNH, { cost: 1, trainLimit: null })).toBeNull();
  });
});

describe("an unaffordable purchase changes nothing at all", () => {
  it("leaves the treasury untouched", () => {
    /* THE REPORT: "the reducer partially executed, drained the $340 to $0". All or nothing means the $340 is
       still there, not that the charge was smaller. */
    const before = board();
    const after = applySandboxAction(before as never, BUY(NNH) as never) as unknown as State;
    expect(treasuryOf(after, NNH)).toBe(340);
  });

  it("does not award the train", () => {
    const before = board();
    const after = applySandboxAction(before as never, BUY(NNH) as never) as unknown as State;
    expect(fleetOf(after, NNH)).toEqual(["6"]);
  });

  it("refuses by identity, so the log cannot call it a success", () => {
    /* #778's MECHANISM IS THE FIX FOR THE THIRD SYMPTOM. The success line was not a separate bug -- the
       reducer had mutated, so it had not refused. Asserted by reference, which is exactly what the drain
       checks. */
    const before = board();
    const after = applySandboxAction(before as never, BUY(NNH) as never);
    expect(after).toBe(before);
    expect(actionWasRefused(before, after, BUY(NNH) as never)).toBe(true);
  });

  it("names the rule rather than leaving the refusal unattributed", () => {
    const reason = refusalReasonFor(board() as never, BUY(NNH) as never);
    expect(reason).toMatch(/cannot pay/);
    expect(reason).toMatch(/\$340/);
  });

  it("does not turn the phase", () => {
    /* THE CONSEQUENCE THAT CORRUPTED THE CURSOR. A D-train purchase turns the phase, which rusts trains,
       trims fleets and rebuilds the operating order -- so a purchase that should never have run took the
       board with it. The state being identical covers this, and it is asserted separately because it is the
       half that explains the dividend refusal. */
    const before = board();
    const after = applySandboxAction(before as never, BUY(NNH) as never) as unknown as State;
    expect(
      (after as unknown as { active_operating_order: number[] }).active_operating_order,
    ).toEqual([NNH, RIVAL]);
    expect((after as unknown as { sub_round_index: number }).sub_round_index).toBe(1);
  });
});

describe("an affordable purchase still works", () => {
  /* THE CONTROL THAT KEEPS THE GATE FROM BEING A WALL. A fix that refused everything would pass every case
     above, which is why this project's rule is that a refusal test needs its opposite beside it. */
  const rich = () =>
    board({
      public_companies: (board() as unknown as { public_companies: unknown[] }).public_companies.map(
        (entry) =>
          (entry as { company_id: number }).company_id === NNH
            ? { ...(entry as object), treasury: "5000" }
            : entry,
      ),
    });

  it("charges the treasury and delivers the train", () => {
    const before = rich();
    const tier = depotInventory(before as never).find(
      (row) => row.remaining === null || row.remaining > 0,
    )!;
    const after = applySandboxAction(before as never, BUY(NNH) as never) as unknown as State;

    expect(after).not.toBe(before);
    expect(treasuryOf(after, NNH)).toBe(5000 - tier.cost);
    expect(fleetOf(after, NNH)).toContain(tier.tier);
  });

  it("is not reported as refused", () => {
    const before = rich();
    const after = applySandboxAction(before as never, BUY(NNH) as never);
    expect(actionWasRefused(before, after, BUY(NNH) as never)).toBe(false);
    expect(refusalReasonFor(before as never, BUY(NNH) as never)).toBeNull();
  });
});

describe("a purchase out of phase is refused", () => {
  /* THE FIRST LINE OF THE LOG: a train bought while the cursor said Dividends. Tested with a treasury that
     could easily afford it, so the refusal can only be the step. */
  const midDividends = () =>
    board({
      operating_sub_phase: "Dividends",
      public_companies: (board() as unknown as { public_companies: unknown[] }).public_companies.map(
        (entry) =>
          (entry as { company_id: number }).company_id === NNH
            ? { ...(entry as object), treasury: "5000" }
            : entry,
      ),
    });

  it("changes nothing during the Dividends step", () => {
    const before = midDividends();
    const after = applySandboxAction(before as never, BUY(NNH) as never);
    expect(after).toBe(before);
  });

  it("says which step it belongs to", () => {
    expect(refusalReasonFor(midDividends() as never, BUY(NNH) as never)).toMatch(
      /Buy Trains step/,
    );
  });

  it("allows it at the Buy Trains step", () => {
    // The discriminating half: same board, same money, one field different.
    const before = board({
      public_companies: (board() as unknown as { public_companies: unknown[] }).public_companies.map(
        (entry) =>
          (entry as { company_id: number }).company_id === NNH
            ? { ...(entry as object), treasury: "5000" }
            : entry,
      ),
    });
    expect(applySandboxAction(before as never, BUY(NNH) as never)).not.toBe(before);
  });

  it("lets a state with no cursor through", () => {
    /* `dividendGate`'s rule, matched deliberately: `operating_sub_phase` is optional on the response, and
       refusing on a missing field would brick a seeded or legacy board on the strength of an absence. */
    const noCursor = board({
      operating_sub_phase: undefined,
      public_companies: (board() as unknown as { public_companies: unknown[] }).public_companies.map(
        (entry) =>
          (entry as { company_id: number }).company_id === NNH
            ? { ...(entry as object), treasury: "5000" }
            : entry,
      ),
    });
    expect(applySandboxAction(noCursor as never, BUY(NNH) as never)).not.toBe(noCursor);
  });
});

describe("a purchase for a corporation that is not operating is refused", () => {
  it("refuses the rival's purchase on NNH's turn", () => {
    /* THE CURSOR RULE, WHICH THE DIVIDEND GATE HAS HAD SINCE #774 AND THIS ONE DID NOT. The rival can afford
       it easily, so money cannot be what refuses. */
    const before = board();
    const after = applySandboxAction(before as never, BUY(RIVAL) as never);
    expect(after).toBe(before);
    expect(refusalReasonFor(before as never, BUY(RIVAL) as never)).toMatch(
      /Only the operating corporation buys trains/,
    );
  });
});

describe("the emergency purchase is exempt from the money check and nothing else", () => {
  const EMERGENCY = { EmergencyBuyHardware: { game_id: 1, protocol_id: NNH } };

  it("still completes when the president covers the shortfall", () => {
    /* THE FEATURE THIS GATE COULD EASILY HAVE BROKEN. `EmergencyBuyHardware` reads the shortfall from a
       treasury it has not funded yet, so a funds check applied to it would refuse the one flow built for
       exactly this state. */
    const before = board({
      player_cash: [
        { player: "p1", cash_vgp: "5000" },
        { player: "p2", cash_vgp: "500" },
      ],
    });
    const after = applySandboxAction(before as never, EMERGENCY as never) as unknown as State;
    expect(after).not.toBe(before);
    expect(fleetOf(after, NNH).length).toBe(2);
  });

  it("is still bound by the step", () => {
    // Exempt from ONE rule. A president may cover a shortfall; they may not buy out of phase.
    const before = board({
      operating_sub_phase: "Dividends",
      player_cash: [
        { player: "p1", cash_vgp: "5000" },
        { player: "p2", cash_vgp: "500" },
      ],
    });
    expect(applySandboxAction(before as never, EMERGENCY as never)).toBe(before);
  });

  it("is not accused of a shortfall it has already covered", () => {
    /* THE REASON, NOT JUST THE OUTCOME. Asking the gate with `requireFunds: true` here would name a rule that
       did not fire -- #784's warning about a confident wrong reason in an authoritative log. */
    const before = board({
      player_cash: [
        { player: "p1", cash_vgp: "5000" },
        { player: "p2", cash_vgp: "500" },
      ],
    });
    expect(refusalReasonFor(before as never, EMERGENCY as never)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Item 1 -- the UI half                                              */
/* ------------------------------------------------------------------ */

describe("only an explicit confirm dispatches a purchase", () => {
  /* ==================================================================
      WHAT THIS CAN AND CANNOT SETTLE
     ==================================================================
     REPORTED: "A player clicked the D-train panel merely to view information, but the UI instantly dispatched
     a purchase action" -- with the player adding that they cannot remember exactly.

     I COULD NOT REPRODUCE A PHANTOM DISPATCH AND SHOULD SAY SO. `onBuyFromBank` has exactly one caller in the
     whole app, it is the `onClick` of a button, that button is `disabled` while the purchase is unaffordable,
     and the handler early-returns on the same condition. Opening the panel, opening the roster, picking a
     quantity and opening the emergency modal all write local state and dispatch nothing.

     SO THESE CASES ARE A REGRESSION FENCE RATHER THAN A FIX. They pin the property the report is about, so
     that a later control added to this panel cannot quietly acquire a dispatch -- which is the only way the
     reported symptom could arise from this file.

     AND THE REDUCER GATE IS WHY THIS IS ENOUGH. Whatever produced that message -- a mis-click, a stale
     `gameState` a frame behind the ref the reducer reads (#784 predicted exactly this: "the panel and the
     reducer disagreed about whether the purchase was legal"), or a path neither of us has found -- it is now
     refused by the authority instead of half-executed. A UI lock alone would have left the door open; the
     door is what this hotfix closed. */
  const PANEL = readStripped("components/TrainPurchasePanel.tsx");

  it("dispatches from exactly one place", () => {
    expect(PANEL.split("onBuyFromBank(").length - 1).toBe(1);
  });

  it("binds that place to a button's onClick", () => {
    const button = sliceBetween(PANEL, "onClick={() => {", "}}");
    expect(button).toContain("onBuyFromBank(nextTier.tier, quantity);");
    expect(button).toContain("if (bankProblem) return;");
  });

  it("disables the button whenever the purchase would be refused", () => {
    /* THE SAME PREDICATE ON THE `disabled` ATTRIBUTE AND INSIDE THE HANDLER. Either alone is a door: a
       disabled button can still be reached by a keyboard in some browsers, and a handler guard alone leaves a
       live-looking control. */
    expect(PANEL).toContain("disabled={bankProblem !== null || !sessionReady || !canAct}");
  });

  it("refuses a purchase the corporation cannot pay for", () => {
    // The panel's own arm for the reported case, so the button is dead before the reducer is ever asked.
    expect(PANEL).toContain("bankTotal > treasury");
  });

  it("opens panels and picks quantities without dispatching", () => {
    /* THE REPORT'S OWN WORDS -- "merely to view information". Every other control in this panel writes local
       state; asserted by name so a later edit that hangs a dispatch on one of them fails here. */
    expect(PANEL).toContain("onClick={() => setLaterTrainsOpen((open) => !open)}");
    expect(PANEL).toContain("onClick={() => setCorporateOpen((open) => !open)}");
    expect(PANEL).toContain("onClick={() => setQuantityText(String(option))}");
    expect(PANEL).toContain("onClick={onEmergencyPurchase}");
  });
});
