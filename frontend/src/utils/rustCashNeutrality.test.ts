/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE (AUDIO FREEZE AUDIT): RUST DESTROYS TRAINS AND MOVES NO MONEY
// ==================================================================
//
// ASKED, before the audio wiring pass was frozen, and phrased as a correction worth keeping: do not
// conflate the train PURCHASE that may turn the phase -- which transfers its price to the Bank -- with the
// RUST that phase change causes, which transfers nothing. The Bank rising on a phase-changing purchase is
// the purchase; it must not also be the rust.
//
// FIVE PATHS, ALL THROUGH THE REAL REDUCER. Nothing below hand-builds a "rusted" state: every case either
// calls `applyPhaseChange` (the one function that rusts) or dispatches a message through
// `applySandboxAction` and reads what came back.
//
// AND THE SEPARATION IS PINNED BY ARITHMETIC, NOT BY A FINAL BALANCE. A case that only checked the Bank's
// figure after a phase-changing purchase would pass against a rust that paid the Bank and a purchase that
// did not, which is the confusion this file was asked to rule out. So the purchase is priced, and the
// Bank's movement is asserted to be EXACTLY that price -- the rust adds nothing on either side.

export {};

const { applyPhaseChange, applySandboxAction, describeFleetLosses, describeReprieveExpiries } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, depotInventory } =
  require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { readStripped, sliceBetween } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");

type GameStateResponse = import("../gameEngine/gameState").GameStateResponse;

const PRR = 1;
const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

interface Corp {
  id: number;
  ticker: string;
  president: string;
  trains: string[];
  treasury?: string;
  pendingRust?: string[];
}

/** `utils/trainDiscard.test.ts`'s board, plus the Bank -- which is the field this file is about. */
function board(input: {
  corps: Corp[];
  operating: number;
  bank?: string;
  returned?: string[];
  gentleRust?: boolean;
}): GameStateResponse {
  const order = input.corps.map((corp) => corp.id);
  return {
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: input.bank ?? "12000",
    private_companies: [],
    variants: resolveVariants(input.gentleRust ? { gentleRust: true } : {}),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    /* BOTH LISTS ALWAYS REPORTED. `describeFleetLosses` diffs `pending_rust_trains` as well as
       `owned_trains`, and #232's rule means an ABSENT list is "the chain did not say" rather than "none"
       -- so a fixture that omits them gets no narration and a case asserting on it proves nothing. Found
       by running it: case 1 below reported no rust for a fleet that visibly lost a train. */
    returned_trains: input.returned ?? [],
    public_companies: input.corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: corp.treasury ?? "3000",
      owned_trains: corp.trains,
      pending_rust_trains: corp.pendingRust ?? [],
      player_holdings: [{ player: corp.president, percentage: 100 }],
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: 3,
      home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}

const bankOf = (state: GameStateResponse) => Number(state.virtual_bank_vgp);
const brokenFlag = (state: GameStateResponse) => state.bank_broken;
const fleetOf = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)?.owned_trains ?? null;
const marksOf = (state: GameStateResponse, id: number) =>
  state.public_companies.find((entry) => entry.company_id === id)?.pending_rust_trains ?? null;

/** Every money field this board carries, so "nothing moved" is a claim about all of them rather than
 *  about the one the author happened to think of. */
const money = (state: GameStateResponse) => ({
  bank: state.virtual_bank_vgp,
  broken: state.bank_broken,
  players: (state.player_cash ?? []).map((entry) => `${entry.player}:${entry.cash_vgp}`).join("|"),
  treasuries: state.public_companies.map((entry) => `${entry.company_id}:${entry.treasury}`).join("|"),
});

/* ------------------------------------------------------------------ */
/* A. Rust moves no money                                              */
/* ------------------------------------------------------------------ */

describe("A. rust destroys trains and moves no money", () => {
  it("1. one corporation-owned train rusting", () => {
    /* ==================================================================
        THE ARRIVING TIER HAS TO BE ON THE BOARD, NOT JUST IN THE ARGUMENT
       ==================================================================
       Found by running it. `applyPhaseChange(state, "4")` rusts correctly whatever else the board holds,
       but `describeFleetLosses` derives the arriving tier from the RESULTING STATE -- the highest train in
       play -- so a fixture where nobody actually owns a 4 leaves it reading phase 3, and it then files the
       destroyed 2-train under `discarded` rather than `rusted`. The narrator is right and the fixture was
       not: a phase change to 4 with no 4-train anywhere is not a board this game can reach. So the buyer
       holds the train that caused the phase, which is also what makes this case a real one. */
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "3"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["4"] },
      ],
      operating: NYC,
    });
    const after = applyPhaseChange(before, "4");
    // The rust really happened -- otherwise this case proves nothing about rust.
    expect(fleetOf(after, PRR)).toEqual(["3"]);
    expect(describeFleetLosses(before, after)[0]?.rusted).toEqual(["2"]);
    expect(money(after)).toEqual(money(before));
    expect(bankOf(after)).toBe(bankOf(before));
    expect(brokenFlag(after)).toBe(brokenFlag(before));
  });

  it("2. several trains, across several corporations", () => {
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2", "3"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2", "4"] },
        { id: BO, ticker: "B&O", president: P3, trains: ["2"] },
      ],
      operating: NYC,
    });
    const after = applyPhaseChange(before, "4");
    expect(fleetOf(after, PRR)).toEqual(["3"]);
    expect(fleetOf(after, NYC)).toEqual(["4"]);
    // A corporation can lose its WHOLE fleet, which is the largest destruction one phase change can do.
    expect(fleetOf(after, BO)).toEqual([]);
    // Four 2-trains across three corporations, all narrated as rust.
    expect(describeFleetLosses(before, after).flatMap((loss) => loss.rusted)).toEqual(["2", "2", "2", "2"]);
    expect(describeFleetLosses(before, after).flatMap((loss) => loss.discarded)).toEqual([]);
    expect(money(after)).toEqual(money(before));
  });

  it("3. a train in the Bank Pool rusting, which pays nobody its face value", () => {
    /* #1314: "a traded-in 4-train sitting in the bank when the first Diesel arrives is scrapped like every
       other 4-train". THE HAZARD THIS CASE IS FOR: a train the Bank is holding disappearing could plausibly
       be read as the Bank realising its value. It is not a sale. Nothing is paid in either direction. */
    const before = board({
      corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["3"] }],
      operating: PRR,
      returned: ["2", "2", "3"],
    });
    const after = applyPhaseChange(before, "4");
    expect(after.returned_trains).toEqual(["3"]);
    expect(money(after)).toEqual(money(before));
    // Not the 2-train's $80 in either direction, and not a cent of anything else.
    expect(bankOf(after)).toBe(bankOf(before));
  });

  it("4. Gentle Rust MARKING destroys nothing and moves nothing", () => {
    const before = board({
      corps: [{ id: PRR, ticker: "PRR", president: P1, trains: ["2", "3"] }],
      operating: PRR,
      gentleRust: true,
    });
    const after = applyPhaseChange(before, "4");
    // #979: the train is still in the fleet, marked -- so there is nothing to have been paid for.
    expect(fleetOf(after, PRR)).toEqual(["2", "3"]);
    expect(marksOf(after, PRR)).toEqual(["2"]);
    expect(money(after)).toEqual(money(before));
  });

  it("5. Gentle Rust EXPIRY destroys the train and moves nothing", () => {
    /* The expiry is a round-transition write inside `settleRoundTransitions`, so this drives a real
       dispatch rather than calling it: the marked corporation's turn ends, and the reducer retires the
       train on the way out. `describeReprieveExpiries` is the narrator that agrees it happened. */
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "3"], pendingRust: ["2"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["4"] },
      ],
      operating: PRR,
      gentleRust: true,
    });
    const after = applySandboxAction(before, { PassTurn: { game_id: 1 } } as never, { actor: P1 });
    expect(after).not.toBe(before);
    // The train is gone from both arrays (#1032), which is the destruction this case is about.
    expect(fleetOf(after, PRR)).toEqual(["3"]);
    expect(marksOf(after, PRR)).toEqual([]);
    expect(describeReprieveExpiries(before, after)[0]?.rusted).toEqual(["2"]);
    expect(bankOf(after)).toBe(bankOf(before));
    expect(brokenFlag(after)).toBe(brokenFlag(before));
    expect(money(after).treasuries).toBe(money(before).treasuries);
    expect(money(after).players).toBe(money(before).players);
  });

  it("cannot break a Bank that is already down to its last dollar", () => {
    /* THE SHARPEST FORM OF THE CLAIM. If rust moved any money at all in the debit direction, a Bank at $1
       is where it would show: `debitBank` latches `bank_broken` on the way past zero (#1561). */
    const before = board({
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2", "2", "2"] },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2", "2"] },
      ],
      operating: PRR,
      bank: "1",
      returned: ["2", "2"],
    });
    const after = applyPhaseChange(before, "4");
    expect(fleetOf(after, PRR)).toEqual([]);
    expect(after.returned_trains).toEqual([]);
    expect(bankOf(after)).toBe(1);
    expect(after.bank_broken).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* B. The purchase is the purchase; the rust is free                    */
/* ------------------------------------------------------------------ */

describe("B. the purchase pays the Bank; the rust it causes pays nothing", () => {
  /* ==================================================================
      THE FIXTURE HAD TO BE LEGAL, WHICH IS ITSELF PART OF THE ANSWER
     ==================================================================
     The first draft parked all six 2-trains on one corporation to empty the depot's cheap tiers, and the
     reducer refused the purchase outright: "B&O holds 2 trains more than the limit of 4; B&O's president
     must discard before anything else happens." That is `pendingDiscardBlock` (#1530) doing its job, and
     it is worth recording here because it is the same rule K-9 is about -- while any corporation is over
     the limit, NOTHING else happens, so a board with a standing obligation cannot dispatch anything at
     all, let alone two events at once.
     SO THE ELEVEN TRAINS ARE SPREAD FOUR/FOUR/THREE, every corporation legal, the depot's head the first
     4-train. */
  const soldOutBelow = (buyer: Corp, bank: string) =>
    board({
      corps: [
        buyer,
        { id: BO, ticker: "B&O", president: P3, trains: ["2", "2", "2", "2"] },
        { id: CO, ticker: "C&O", president: P3, trains: ["2", "2", "3", "3"] },
        { id: PRR, ticker: "PRR", president: P1, trains: ["3", "3", "3"] },
      ],
      operating: NYC,
      bank,
    });

  const BUY = (id: number) => ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id } }) as never;

  it("charges exactly the train's price, and the rust adds nothing to it", () => {
    const before = soldOutBelow({ id: NYC, ticker: "NYC", president: P2, trains: [], treasury: "3000" }, "12000");
    const head = depotInventory(before).find((row) => (row.remaining ?? 0) > 0);
    expect(head?.tier).toBe("4");
    const price = head!.cost;

    const after = applySandboxAction(before, BUY(NYC), { actor: P2 });
    expect(after).not.toBe(before);
    // The phase turned and trains really rusted: six 2-trains, across two corporations.
    expect(derivePhase(after)?.tier).toBe("4");
    expect(fleetOf(after, BO)).toEqual([]);
    expect(fleetOf(after, CO)).toEqual(["3", "3"]);
    const rusted = describeFleetLosses(before, after, BUY(NYC)).flatMap((loss) => loss.rusted);
    expect(rusted).toEqual(["2", "2", "2", "2", "2", "2"]);

    /* ==================================================================
        THE SEPARATION, AS ARITHMETIC
       ==================================================================
       The Bank is up by the PRICE and by nothing else. Six 2-trains ($80) and no 3-trains were destroyed
       in this transition; had the rust credited the Bank their value, or debited it, this equality is the
       assertion that would fail. A bare `bankOf(after) > bankOf(before)` would not. */
    expect(bankOf(after) - bankOf(before)).toBe(price);
    // And the money came from the buyer's treasury, in the same amount. Nothing was minted.
    const treasuryBefore = Number(before.public_companies.find((c) => c.company_id === NYC)!.treasury);
    const treasuryAfter = Number(after.public_companies.find((c) => c.company_id === NYC)!.treasury);
    expect(treasuryBefore - treasuryAfter).toBe(price);
    // Players are untouched either way.
    expect(money(after).players).toBe(money(before).players);
  });

  it("is the same price whether the purchase rusts six trains or none", () => {
    /* ==================================================================
        THE CONTROL, AND WHY IT IS THE SECOND 4-TRAIN RATHER THAN A RUST-FREE BOARD
       ==================================================================
       There is no board on which buying the FIRST 4-train rusts nothing: reaching it means every 2 and 3
       has left the depot, and wherever they went -- a fleet or the pool -- the arriving 4 scraps them. So
       the control is the same tier bought a second time: phase 4 is already in play, nothing rusts, and
       the price must be identical. Same message, same tier, one event's worth of difference. */
    const before = soldOutBelow({ id: NYC, ticker: "NYC", president: P2, trains: [] }, "12000");
    const first = applySandboxAction(before, BUY(NYC), { actor: P2 });
    const paidWithRust = bankOf(first) - bankOf(before);
    expect(describeFleetLosses(before, first, BUY(NYC)).flatMap((loss) => loss.rusted).length).toBe(6);

    const second = applySandboxAction(first, BUY(NYC), { actor: P2 });
    expect(second).not.toBe(first);
    const paidNoRust = bankOf(second) - bankOf(first);
    // Nothing rusted on the second, which is what makes it a control.
    expect(derivePhase(second)?.tier).toBe("4");
    expect(describeFleetLosses(first, second, BUY(NYC))).toEqual([]);

    expect(paidWithRust).toBe(paidNoRust);
    expect(paidWithRust).toBeGreaterThan(0);
  });

  it("moves the Bank UP on the action that rusts, which is why rust cannot break it", () => {
    /* A Bank at $3 and six trains destroyed in the same dispatch. If rust cost the Bank anything, this is
       where `bank_broken` would latch. */
    const before = soldOutBelow({ id: NYC, ticker: "NYC", president: P2, trains: [] }, "3");
    const after = applySandboxAction(before, BUY(NYC), { actor: P2 });
    expect(fleetOf(after, BO)).toEqual([]);
    expect(bankOf(after)).toBeGreaterThan(bankOf(before));
    expect(after.bank_broken).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* C. K-9 reachability                                                 */
/* ------------------------------------------------------------------ */

describe("C. can one legal action both rust and break the Bank (K-9)", () => {
  const REDUCER = readStripped("gameEngine/sandboxSession.ts");

  it("reaches rust from exactly two arms, and both CREDIT the Bank first", () => {
    /* THE CALL GRAPH IS THE ARGUMENT. `applyPhaseChange` is the only function that rusts anything, and it
       is reached from two places: the depot purchase and the Diesel exchange. Both are purchases, both
       move the price from a treasury TO the Bank before the phase is allowed to settle. */
    expect((REDUCER.match(/applyPhaseChange\(/g) ?? []).length).toBe(3); // the declaration + two calls
    const depot = sliceBetween(REDUCER, "const paid = transfer(state, { corporation: companyId }, BANK, tier.cost);", "applyPhaseChange(delivered, after) : delivered;");
    expect(depot).toContain("const before = derivePhase(state)?.tier ?? null;");
    expect(depot).not.toContain("debitBank");
    // The Diesel exchange is a purchase too, and it returns the traded train to the pool for free.
    const diesel = sliceBetween(REDUCER, "returned_trains: [...(exchanged.returned_trains ?? []), model_type],", "applyPhaseChange(returned, after) : returned;");
    expect(diesel).not.toContain("debitBank");
  });

  it("debits the Bank from three places, none of which rusts anything", () => {
    /* The other half of the graph. `debitBank` is the only writer that can latch `bank_broken` (#1561),
       and its callers are the dividend payout, the private-revenue pass and the float capitalisation --
       none of which buys a train, and therefore none of which can turn the phase. */
    const LEDGER = readStripped("gameEngine/cashLedger.ts");
    expect(LEDGER).toContain("export function debitBank(");
    expect((REDUCER.match(/debitBank\(/g) ?? []).length).toBe(2);
    const payout = sliceBetween(REDUCER, "const funded = debitBank(state, settlement.totalPaid);", "for (const share of settlement.players) {");
    expect(payout).not.toContain("applyPhaseChange");
    const privates = sliceBetween(REDUCER, "const funded = debitBank(state, total);", "for (const payout of payouts) {");
    expect(privates).not.toContain("applyPhaseChange");
    const FLOAT = readStripped("gameEngine/floatThreshold.ts");
    expect(FLOAT).toContain("debitBank(");
    expect(FLOAT).not.toContain("applyPhaseChange");
  });

  it("does not rust on the action that breaks the Bank", () => {
    /* ==================================================================
        THE OTHER DIRECTION, AND THE FIRST DRAFT OF THIS CASE PROVED NOTHING
       ==================================================================
       It dispatched a dividend at `operating_sub_phase: "Revenue"` and wrapped its assertions in
       `if (after !== before)`. The dispatch was REFUSED -- identity back -- so the branch never ran and the
       case passed vacuously, which is #886's shape wearing a conditional instead of a backwards slice.
       `utils/bankBreakLatch.test.ts`'s fixture is the one that actually pays: the cursor is deliberately
       ABSENT (`dividendGate` lets an unknown one through) and the corporation carries a filed
       `last_route_revenue`. Rebuilt on it, with the escape hatch deleted -- the break is now asserted, so
       if the dispatch is ever refused again this case fails instead of lying. */
    const before = {
      current_round_type: "OperatingRound",
      active_operating_order: [PRR],
      active_corporation_index: 0,
      sub_round_index: 1,
      macro_round_number: 3,
      virtual_bank_vgp: "10",
      player_addresses: [P1, P2],
      player_cash: [
        { player: P1, cash_vgp: "0" },
        { player: P2, cash_vgp: "100" },
      ],
      priority_deal_index: 0,
      active_player_index: 0,
      consecutive_passes: 0,
      private_companies: [],
      returned_trains: [],
      public_companies: [
        {
          company_id: PRR,
          ticker: "PRR",
          is_floated: true,
          president: P1,
          treasury: "500",
          owned_trains: ["2", "4"],
          pending_rust_trains: [],
          last_route_revenue: "30",
          player_holdings: [{ player: P1, percentage: 100 }],
          bank_pool_percentage: 0,
          ipo_pool_percentage: 100,
          par_value: "100",
          station_token_hexes: [],
          station_tokens: [],
        },
      ],
    } as unknown as GameStateResponse;

    const after = applySandboxAction(
      before,
      { DeclareDividends: { game_id: 0, protocol_id: PRR, distribute: true, revenue_amount: "30" } } as never,
    );
    // THE BREAK REALLY HAPPENED: $10 in the Bank, $30 paid out, latched on the way past zero (#1561).
    expect(after).not.toBe(before);
    expect(after.bank_broken).toBe(true);
    expect(bankOf(after)).toBeLessThanOrEqual(0);
    // AND NOT ONE TRAIN MOVED. The 2-train is still there, on a board that is at phase 4 and could rust it.
    expect(derivePhase(before)?.tier).toBe("4");
    expect(fleetOf(after, PRR)).toEqual(["2", "4"]);
    expect(describeFleetLosses(before, after)).toEqual([]);
    expect(describeReprieveExpiries(before, after)).toEqual([]);
  });

  it("CONCLUSION: the two events are driven by opposite money flows, so K-9 is not reachable", () => {
    /* ==================================================================
        WHY THIS IS A STRUCTURAL ANSWER AND NOT A SURVEY
       ==================================================================
       Rust requires a phase change; a phase change requires a train to arrive from the depot or the
       Diesel exchange; both of those move money INTO the Bank before the phase settles, and neither ever
       calls `debitBank`. The break requires `debitBank` to take the balance to or below zero, and its
       three callers pay dividends, pay private revenue and capitalise a float -- none of them buys a
       train. There is no arm in this reducer that does both, and the money flows point in opposite
       directions, so there is no near miss either.
       AND THE CHAIN DOES NOT SMUGGLE ONE IN. Every dispatch runs `applyOneAction` and then
       `settleRoundTransitions`, and that transition CAN pay private revenue -- a Bank debit. But it fires
       on `stock_round_just_ended` / `operating_round_just_ended`, which a purchase does not set: the round
       ends when the last corporation's turn does, and a purchase is not a turn ending. So the one place
       the two could have met in a single dispatch does not connect. */
    expect(REDUCER).toContain("if (state.stock_round_just_ended) {");
    expect(REDUCER).toContain("settleRoundTransitions(seatBoundaryExchange(state, applyOneAction(state, msg, ctx), ctx), ctx)");
    const depotArm = sliceBetween(REDUCER, "const paid = transfer(state, { corporation: companyId }, BANK, tier.cost);", "applyPhaseChange(delivered, after) : delivered;");
    expect(depotArm).not.toContain("just_ended");
    expect(depotArm).not.toContain("applyPrivateRevenue");
  });

  it("states which pairs CAN share one action, and which cannot", () => {
    /* BANK BREAK + RUST: no (above).
       BANK BREAK + DISCARD: no. A discard is `DiscardTrain`, which moves a train from a fleet to the pool
         and is explicit that "nobody is paid" -- the arm touches no money field at all.
       RUST + DISCARD: no, and for a reason worth stating because it is the one a reader expects to be
         yes. A phase change can CREATE a train-limit obligation at the same moment it rusts -- but #1530
         made the obligation and the discard two different things: the phase takes nothing, and the
         president's `DiscardTrain` is a separate action taken later, by a different actor, possibly
         several turns later. The limit becoming active is not the discard. */
    /* ANCHORED ON THE ARM'S OWN LINES. `if ("DiscardTrain" in msg) {` appears twice -- the gate at the
       top of the dispatcher and the arm that moves the train -- and the first occurrence is the gate,
       whose region proves nothing about what the discard does. #886's rule about a slice an assertion is
       not actually over. */
    const discardArm = sliceBetween(REDUCER, "const at = owned.indexOf(model_type);", "returned_trains: [...(state.returned_trains ?? []), model_type],");
    expect(discardArm).not.toContain("virtual_bank_vgp");
    expect(discardArm).not.toContain("debitBank");
    expect(discardArm).not.toContain("creditBank");
    expect(discardArm).not.toContain("transfer(");
    expect(discardArm).not.toContain("applyPhaseChange");
    // And the phase change itself discards nothing (#1530), so no action can raise both events.
    const PHASE = sliceBetween(REDUCER, "export function applyPhaseChange(", "export function describePrivateClosures(");
    expect(PHASE).not.toContain("virtual_bank_vgp");
    expect(PHASE).not.toContain("debitBank");
    expect(PHASE).not.toContain("bank_broken");
    expect(PHASE).not.toContain("trimToTrainLimit");
  });
});
