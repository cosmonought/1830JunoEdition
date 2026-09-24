/** @jest-environment node */
//
// ==================================================================
//  DESIGN NOTE 1700 (harness): GENTLE RUST GR-2 -- A REPRIEVED TRAIN MAY NOT BE SOLD OR TRADED IN
// ==================================================================
//
// AUTHORITY: `VARIANT_CERT_GENTLE_RUST_AUDIT_2026-09-23.md` rev 2, owner rulings OD-GR-1 (no sale / transfer to
// another corporation) and OD-GR-2 (no Diesel trade-in, $800 or the Level Playing Field's $750); clauses GR-S3,
// GR-S12, GR-S13, GR-S24. The one multiset authority is `gentleRustGrace.ts` (DN 1700), asked by
// `trainSaleRefusal` (#1592) and by `exchangeableTrains` / `dieselExchangeRefusal` (#1303).
//
// EVERY MARK IS A REAL ONE UNLESS LABELLED. Boards are legal pinned v8 Operating Rounds built as GR-1's harness
// builds them (depot derived from the fleets, a home token on each home hex, a chart); trains are doomed by
// dispatching the phase-changing purchase through `applySandboxAction` with the acting president as the actor.
// Hand-written state appears only where the representation admits a board today's messages cannot reach, and
// each such case is labelled REPRESENTATION:
//   * an ordinary copy beside a reprieved copy of the SAME model -- every copy of a doomed model is marked at
//     once and pool copies are scrapped, so only the two holes GR-2 closes could ever have made one;
//   * a rival-doomed train at its owner's Buy Trains step -- it expires at the end of that turn's Run Routes;
//   * a seller still carrying this turn's self-doom while another corporation buys -- the list is dropped at
//     the seller's turn end, and only the operating corporation buys;
//   * an offer standing on a train that became reprieved after it was made -- the offer hold freezes the board.
// They pin the multiset contract the helper promises, which the representation permits even where play does not.
//
// A refusal is proven by digest (#778's identity cannot be the witness on a board carrying a chart, #1196) and by
// the three lists standing still. After every ACCEPTED train movement on these paths the sub-multiset invariant
//     pending_rust_doomed_this_turn <= pending_rust_trains <= owned_trains      (by model and multiplicity)
// is asserted for every corporation.

import type { GameStateResponse, PublicCompanyState } from "../gameEngine/gameState";
import type { MapGridResponse } from "../components/hexContractTypes";

export {};

const { applySandboxAction, sandboxChartStepReport } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { derivePhase, depotInventory } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { stateDigest, canonicalJson } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { pendingTrainDiscards, discardTrainRefusal } =
  require("../gameEngine/trainDiscard") as typeof import("../gameEngine/trainDiscard");
const { unreprievedCopiesOf, unreprievedTrains, ownsOnlyReprievedCopiesOf, graceTurnReprieves } =
  require("../gameEngine/gentleRustGrace") as typeof import("../gameEngine/gentleRustGrace");
const { trainSaleRefusal, proposeTrainPurchaseRefusal, answerTrainPurchaseRefusal } =
  require("../gameEngine/trainSaleAuthority") as typeof import("../gameEngine/trainSaleAuthority");
const {
  exchangeableTrains,
  dieselExchangeRefusal,
  dieselExchangeCostFor,
  DIESEL_EXCHANGE_COST,
  LPF_DIESEL_EXCHANGE_COST,
} = require("../gameEngine/dieselExchange") as typeof import("../gameEngine/dieselExchange");
const { sandboxActionContext } = require("../gameEngine/actionContext") as typeof import("../gameEngine/actionContext");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { replayLog } = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { projectBloodPriceMove } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { moneyTotal } = require("../gameEngine/cashLedger") as typeof import("../gameEngine/cashLedger");
const { actionWasRefused, refusalReasonFor } = require("./refusedAction") as typeof import("./refusedAction");
const S = require("./offerMatrix74Support") as typeof import("./offerMatrix74Support");

/* ------------------------------------------------------------------ */
/* Boards                                                             */
/* ------------------------------------------------------------------ */

const PRR = 1;
const NYC = 2;
const BO = 4;
const CO = 5;
const P1 = "p1";
const P2 = "p2";
const P3 = "p3";

const TICKER: Record<number, string> = { [PRR]: "PRR", [NYC]: "NYC", [BO]: "B&O", [CO]: "C&O" };
/** P1 presides over PRR and C&O -- the shell's same-president direct sale (#1592) between those two. */
const PRESIDENT: Record<number, string> = { [PRR]: P1, [NYC]: P2, [BO]: P3, [CO]: P1 };
const HOME: Record<number, string> = { [PRR]: "H6", [NYC]: "I9", [BO]: "J6", [CO]: "I5" };
const PRICE: Record<number, number> = { [PRR]: 100, [NYC]: 90, [BO]: 80, [CO]: 70 };

function at(label: string): { q: number; r: number } {
  const hex = STATIC_BOARD_HEXES.find((entry) => entry.label === label);
  if (!hex) throw new Error(`no hex ${label}`);
  return { q: hex.q, r: hex.r };
}

interface Corp {
  id: number;
  trains: string[];
  treasury?: string;
  /** REPRESENTATION only (see the header): marks written by hand. */
  marks?: string[];
  doomed?: string[];
  /** Hand-set Carcosa gilding (the Yellow Sign's gift is not driven here). */
  gilded?: string[];
}

/** A legal pinned Operating Round, as GR-1's harness builds it. `homeless` drops the home labels and tokens (the
 *  Level Playing Field boards: its map rebinds the hex table, and these cases are about trains, not stations). */
function board(input: {
  corps: Corp[];
  operating: number;
  step?: string;
  sub?: number;
  length?: number;
  gentle?: boolean;
  lpf?: boolean;
  returned?: string[];
  homeless?: boolean;
}): GameStateResponse {
  const order = input.corps.map((entry) => entry.id);
  return {
    game_id: 1,
    player_addresses: [P1, P2, P3],
    player_cash: [P1, P2, P3].map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "12000",
    private_companies: [],
    variants: resolveVariants({
      ...(input.gentle === false ? {} : { gentleRust: true }),
      ...(input.lpf ? { levelPlayingField: true } : {}),
    }),
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    sub_round_index: input.sub ?? 1,
    operating_round_sequence_length: input.length ?? 2,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(input.operating),
    operating_sub_phase: input.step ?? "Hardware",
    rules_engine_version: RULES_ENGINE_VERSION,
    returned_trains: input.returned ?? [],
    market_positions: Object.fromEntries(
      input.corps.map((entry, index) => [entry.id, { price: PRICE[entry.id], x: 5 + index, y: 4, enteredAt: index + 1 }]),
    ),
    public_companies: input.corps.map((entry) => ({
      company_id: entry.id,
      ticker: TICKER[entry.id],
      is_floated: true,
      president: PRESIDENT[entry.id],
      par_value: "100",
      ipo_pool_percentage: 0,
      bank_pool_percentage: 0,
      treasury: entry.treasury ?? "3000",
      owned_trains: entry.trains,
      pending_rust_trains: entry.marks ?? [],
      ...(entry.doomed ? { pending_rust_doomed_this_turn: entry.doomed } : {}),
      ...(entry.gilded ? { carcosan_trains: entry.gilded, is_carcosan: true } : {}),
      player_holdings: [{ player: PRESIDENT[entry.id], percentage: 60 }],
      station_token_hexes: input.homeless ? [] : [[at(HOME[entry.id]).q, at(HOME[entry.id]).r]],
      station_tokens: input.homeless ? [] : [[at(HOME[entry.id]).q, at(HOME[entry.id]).r, 0]],
      station_token_limit: 3,
      home_hex_label: input.homeless ? null : HOME[entry.id],
    })),
  } as unknown as GameStateResponse;
}

/* ------------------------------------------------------------------ */
/* Driving the reducer                                                */
/* ------------------------------------------------------------------ */

const company = (state: GameStateResponse, id: number): PublicCompanyState =>
  state.public_companies.find((entry) => entry.company_id === id)!;
const fleetOf = (state: GameStateResponse, id: number) => [...(company(state, id).owned_trains ?? [])];
const marksOf = (state: GameStateResponse, id: number) => [...(company(state, id).pending_rust_trains ?? [])];
const doomedOf = (state: GameStateResponse, id: number) => company(state, id).pending_rust_doomed_this_turn;
const treasuryOf = (state: GameStateResponse, id: number) => Number(company(state, id).treasury);
const acting = (state: GameStateResponse): number | null =>
  state.current_round_type === "OperatingRound" ? state.active_operating_order[state.active_corporation_index] ?? null : null;
const actorOf = (state: GameStateResponse): string => {
  const id = acting(state);
  if (id !== null) return company(state, id).president!;
  return state.player_addresses[state.active_player_index];
};
const where = (state: GameStateResponse) =>
  `${state.current_round_type} ${state.macro_round_number}.${state.sub_round_index} corp ${acting(state)} @ ${state.operating_sub_phase}`;

type Msg = Parameters<typeof applySandboxAction>[1];
const dispatch = (state: GameStateResponse, msg: Msg, actor: string = actorOf(state)) => applySandboxAction(state, msg, { actor });

/** Applies a message the board must accept. A refusal is a harness failure with the board's position in it. */
function send(state: GameStateResponse, msg: Msg, actor?: string): GameStateResponse {
  const after = dispatch(state, msg, actor);
  if (stateDigest(after) === stateDigest(state)) throw new Error(`refused at ${where(state)}: ${JSON.stringify(msg)}`);
  return after;
}
const refused = (state: GameStateResponse, msg: Msg, actor?: string) => stateDigest(dispatch(state, msg, actor)) === stateDigest(state);

const BUY = (id: number, model?: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, ...(model ? { model_type: model } : {}) } }) as unknown as Msg;
const BUY_RETURNED = (id: number, model: string) =>
  ({ BuyHardwareFromPool: { game_id: 1, protocol_id: id, returned_model_type: model } }) as unknown as Msg;
const ADVANCE = (state: GameStateResponse) => ({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: acting(state) } }) as unknown as Msg;
const PASS = { PassTurn: { game_id: 1 } } as unknown as Msg;
const SALE = (buyer: number, seller: number, model: string, price = "1") =>
  ({ BuyTrainFromCorporation: { game_id: 1, buyer_protocol_id: buyer, seller_protocol_id: seller, model_type: model, price } }) as unknown as Msg;
const PROPOSE = (buyer: number, seller: number, model: string, price = "1") => S.M.proposeTrain(seller, buyer, model, price) as unknown as Msg;
const ANSWER = (seller: number, accept: boolean) => S.M.answerTrain(seller, accept) as unknown as Msg;
const EXCHANGE = (id: number, model: string) =>
  ({ ExchangeTrainForDiesel: { game_id: 1, protocol_id: id, model_type: model } }) as unknown as Msg;
const DISCARD = (id: number, model: string) => ({ DiscardTrain: { game_id: 1, protocol_id: id, model_type: model } }) as unknown as Msg;

/** Advances the acting corporation's cursor to `step` (Track -> Tokens -> Routes -> Dividends -> Hardware). */
function advanceTo(state: GameStateResponse, step: string): GameStateResponse {
  let now = state;
  for (let guard = 0; now.operating_sub_phase !== step; guard += 1) {
    if (guard > 6) throw new Error(`never reached ${step} from ${where(state)}`);
    now = send(now, ADVANCE(now));
  }
  return now;
}

/** The sale authority at the settlement moment, as the reducer's core gate and ingress ask it. */
const saleRefusal = (state: GameStateResponse, buyer: number, seller: number, model: string, actor: string | null = P1, price = "1") =>
  trainSaleRefusal(state, { buyerId: buyer, sellerId: seller, model, price }, actor, undefined, "settlement");

/* ------------------------------------------------------------------ */
/* The invariant and the lists a refusal may not touch                */
/* ------------------------------------------------------------------ */

const countOf = (list: readonly string[] | null | undefined, model: string) => (list ?? []).filter((entry) => entry === model).length;

/** doomed-this-turn <= marks <= fleet, by model and multiplicity, for every corporation on the board. */
function expectMarksWithinFleets(state: GameStateResponse): void {
  for (const entry of state.public_companies) {
    const owned = entry.owned_trains ?? [];
    const marks = entry.pending_rust_trains ?? [];
    const doomed = entry.pending_rust_doomed_this_turn ?? [];
    for (const model of Array.from(new Set([...owned, ...marks, ...doomed]))) {
      const row = [entry.ticker, model, countOf(doomed, model), countOf(marks, model), countOf(owned, model)];
      const ok = countOf(doomed, model) <= countOf(marks, model) && countOf(marks, model) <= countOf(owned, model);
      expect([...row, ok]).toEqual([...row, true]);
    }
  }
}

/** The three lists of every corporation, verbatim -- what a refused transaction may not move. */
const lists = (state: GameStateResponse) =>
  state.public_companies.map((entry) => [
    entry.company_id,
    [...(entry.owned_trains ?? [])],
    [...(entry.pending_rust_trains ?? [])],
    entry.pending_rust_doomed_this_turn === undefined ? "absent" : [...entry.pending_rust_doomed_this_turn],
  ]);

/** Everything a refused sale or exchange may not partially alter, spelled out (the digest already covers it;
 *  this names the pieces the brief lists so a failure says which one moved). */
function expectNothingMoved(before: GameStateResponse, after: GameStateResponse): void {
  expect(lists(after)).toEqual(lists(before));
  expect(after.public_companies.map((entry) => entry.treasury)).toEqual(before.public_companies.map((entry) => entry.treasury));
  expect(after.player_cash).toEqual(before.player_cash);
  expect(after.virtual_bank_vgp).toBe(before.virtual_bank_vgp);
  expect(after.returned_trains ?? []).toEqual(before.returned_trains ?? []);
  expect(canonicalJson(after.market_positions)).toBe(canonicalJson(before.market_positions));
  expect([after.current_round_type, after.active_corporation_index, after.operating_sub_phase]).toEqual([
    before.current_round_type,
    before.active_corporation_index,
    before.operating_sub_phase,
  ]);
  expect(derivePhase(after)?.tier).toBe(derivePhase(before)?.tier);
  expect(after.train_purchase_offer ?? null).toEqual(before.train_purchase_offer ?? null);
  expect(stateDigest(after)).toBe(stateDigest(before));
}

/* ================================================================== */
/* H. The shared multiset authority                                   */
/* ================================================================== */

describe("H. one multiset authority: owned copies minus marked copies, never the model as a whole", () => {
  it("counts the copies no mark covers, by multiplicity", () => {
    expect(unreprievedCopiesOf({ owned_trains: ["4", "4"], pending_rust_trains: ["4"] }, "4")).toBe(1);
    expect(unreprievedCopiesOf({ owned_trains: ["4", "4", "4"], pending_rust_trains: ["4", "4"] }, "4")).toBe(1);
    expect(unreprievedCopiesOf({ owned_trains: ["4"], pending_rust_trains: ["4"] }, "4")).toBe(0);
    expect(unreprievedCopiesOf({ owned_trains: ["4", "5"], pending_rust_trains: ["4"] }, "5")).toBe(1);
    // Absent lists are "not said" (#232): no marks subtract nothing; no fleet owns nothing.
    expect(unreprievedCopiesOf({ owned_trains: ["4", "4"] }, "4")).toBe(2);
    expect(unreprievedCopiesOf({ owned_trains: null, pending_rust_trains: ["4"] }, "4")).toBe(0);
    // A surplus mark never manufactures a free copy, and never drives the count below zero.
    expect(unreprievedCopiesOf({ owned_trains: ["4"], pending_rust_trains: ["4", "4"] }, "4")).toBe(0);
  });

  it("does not subtract this turn's self-doom a second time: it is already among the marks", () => {
    const self = { owned_trains: ["4", "4"], pending_rust_trains: ["4"], pending_rust_doomed_this_turn: ["4"] };
    expect(unreprievedCopiesOf(self, "4")).toBe(1);
    expect(unreprievedTrains(self)).toEqual(["4"]);
    expect(ownsOnlyReprievedCopiesOf(self, "4")).toBe(false);
    // ...and the GR-1 helper still reads the same list its own way: nothing owed this turn.
    expect(graceTurnReprieves(self)).toEqual([]);
  });

  it("names the free copies in roster order, each mark spending the earliest matching train (the chips' order)", () => {
    expect(unreprievedTrains({ owned_trains: ["4", "4", "5"], pending_rust_trains: ["4"] })).toEqual(["4", "5"]);
    expect(unreprievedTrains({ owned_trains: ["4", "5", "4"], pending_rust_trains: ["4"] })).toEqual(["5", "4"]);
    expect(unreprievedTrains({ owned_trains: ["2", "2", "3", "4"], pending_rust_trains: ["2", "2"] })).toEqual(["3", "4"]);
    expect(unreprievedTrains({ owned_trains: ["4"], pending_rust_trains: ["4"] })).toEqual([]);
    expect(unreprievedTrains({ owned_trains: ["4", "6"] })).toEqual(["4", "6"]);
  });

  it("distinguishes 'owns the model' from 'owns a copy it may move'", () => {
    expect(ownsOnlyReprievedCopiesOf({ owned_trains: ["4"], pending_rust_trains: ["4"] }, "4")).toBe(true);
    expect(ownsOnlyReprievedCopiesOf({ owned_trains: ["4", "4"], pending_rust_trains: ["4", "4"] }, "4")).toBe(true);
    expect(ownsOnlyReprievedCopiesOf({ owned_trains: ["4", "4"], pending_rust_trains: ["4"] }, "4")).toBe(false);
    expect(ownsOnlyReprievedCopiesOf({ owned_trains: ["5"], pending_rust_trains: ["4"] }, "4")).toBe(false); // does not own it
  });
});

/* ================================================================== */
/* S. OD-GR-1 -- no sale / transfer of a reprieved train              */
/* ================================================================== */

/** Phase 3 with every 2-train and every 3-train out (the sixth 2 in the Bank Pool), so PRR's depot purchase is the
 *  first 4: it dooms every 2 in play -- PRR's own two (a self-trigger, owed PRR's NEXT turn, GR-1), NYC's two and
 *  C&O's one -- and scraps the pool's. PRR operates first of three, round 1 of 2. P1 presides over PRR and C&O. */
const saleStart = (gentle = true, gilded?: string[]) =>
  board({
    corps: [
      { id: PRR, trains: ["2", "2", "3"] },
      { id: NYC, trains: ["2", "2", "3", "3"] },
      { id: CO, trains: ["2", "3", "3"], ...(gilded ? { gilded } : {}) },
    ],
    operating: PRR,
    returned: ["2"],
    gentle,
  });
const headIs = (state: GameStateResponse, tier: string) =>
  expect(depotInventory(state).find((row) => row.remaining === null || (row.remaining ?? 0) > 0)?.tier).toBe(tier);
/** The board right after PRR's first 4, every mark written by the real phase change. */
const rusted = () => {
  const before = saleStart();
  return send(before, BUY(PRR));
};

const SOLE_2_CO = "C&O's 2-train is on its Gentle Rust final run — it cannot be sold to another corporation.";
const EVERY_2 = (ticker: string) => `Every 2-train ${ticker} holds is on its Gentle Rust final run — none can be sold to another corporation.`;

describe("S. OD-GR-1: a reprieved train may not be sold or transferred to another corporation", () => {
  it("the rust is real: the first 4 marks every 2-train in play -- PRR's own as this turn's self-doom -- and scraps the pool's", () => {
    const before = saleStart();
    headIs(before, "4");
    const after = send(before, BUY(PRR));
    expect(derivePhase(after)?.tier).toBe("4");
    expect([fleetOf(after, PRR), marksOf(after, PRR), doomedOf(after, PRR)]).toEqual([["2", "2", "3", "4"], ["2", "2"], ["2", "2"]]);
    expect([fleetOf(after, NYC), marksOf(after, NYC), doomedOf(after, NYC)]).toEqual([["2", "2", "3", "3"], ["2", "2"], undefined]);
    expect([fleetOf(after, CO), marksOf(after, CO), doomedOf(after, CO)]).toEqual([["2", "3", "3"], ["2"], undefined]);
    expect(after.returned_trains).toEqual([]);
    expectMarksWithinFleets(after);
  });

  it("S1 (probe P6 closed): the sole requested copy is reprieved -- refused before anything moves, by the one predicate, at ingress and in the reducer", () => {
    const s = rusted();
    const msg = SALE(PRR, CO, "2");
    expect(saleRefusal(s, PRR, CO, "2")).toBe(SOLE_2_CO);
    expect(S.ingress(s, P1, msg)).toBe(SOLE_2_CO);
    const after = dispatch(s, msg, P1);
    expectNothingMoved(s, after);
    // The same refusal whatever the price or the sender: no author (#1686) and a generous price alike.
    expect(saleRefusal(s, PRR, CO, "2", null, "300")).toBe(SOLE_2_CO);
    expectNothingMoved(s, applySandboxAction(s, SALE(PRR, CO, "2", "300"), { actor: null }));
  });

  it("S1 at every moment of the offer: proposal refused; an answer re-runs the rule; a refused settlement moves nothing but #1596's retirement", () => {
    const s = rusted();
    // Proposal (NYC's president is P2, so this is the offer path): both of NYC's 2-trains are reprieved.
    const proposal = { seller_protocol_id: NYC, buyer_protocol_id: PRR, model_type: "2", price: "1" };
    expect(proposeTrainPurchaseRefusal(s, proposal, P1, undefined)).toBe(EVERY_2("NYC"));
    expect(refused(s, PROPOSE(PRR, NYC, "2"), P1)).toBe(true);

    // REPRESENTATION: an offer standing on a train that became reprieved after it was made (unreachable -- the offer
    // hold freezes the board while an offer stands). The acceptance is refused and the offer stands; a rejection passes.
    const offer = {
      seller_protocol_id: NYC,
      seller_ticker: "NYC",
      seller_president: P2,
      buyer_protocol_id: PRR,
      buyer_ticker: "PRR",
      model_type: "2",
      price: "1",
      instance: 1,
    };
    const standing = { ...s, train_purchase_offer: offer, offer_serial: 1 } as GameStateResponse;
    expect(answerTrainPurchaseRefusal(standing, { seller_protocol_id: NYC, accept: true }, P2, undefined)).toBe(EVERY_2("NYC"));
    expectNothingMoved(standing, dispatch(standing, ANSWER(NYC, true), P2));
    const rejected = dispatch(standing, ANSWER(NYC, false), P2);
    expect(rejected.train_purchase_offer ?? null).toBeNull();
    expect(lists(rejected)).toEqual(lists(standing));

    // REPRESENTATION: an ACCEPTED offer for it. The settlement is refused by the same rule; #1596 retires the offer
    // (the one deliberate mutation of a refusal) and nothing else moves -- no train, no money, no mark.
    const accepted = { ...standing, train_purchase_offer: { ...offer, accepted: true } } as GameStateResponse;
    expect(saleRefusal(accepted, PRR, NYC, "2")).toBe(EVERY_2("NYC"));
    const settled = dispatch(accepted, SALE(PRR, NYC, "2"), P1);
    expect(settled.train_purchase_offer ?? null).toBeNull();
    expect(S.differing(accepted, settled)).toEqual(["train_purchase_offer"]);
    expect(lists(settled)).toEqual(lists(accepted));
  });

  it("S2 / §9: a self-doomed train cannot escape its next-turn reprieve through a sale -- refused in every rival's turn, retired in its own", () => {
    let state = rusted();
    expect([marksOf(state, PRR), doomedOf(state, PRR)]).toEqual([["2", "2"], ["2", "2"]]);

    // PRR's turn ends: the self-doom is now owed PRR's next turn (GR-1), and the trains stay owned and marked.
    state = send(state, PASS);
    expect(acting(state)).toBe(NYC);
    expect([fleetOf(state, PRR), marksOf(state, PRR), doomedOf(state, PRR)]).toEqual([["2", "2", "3", "4"], ["2", "2"], undefined]);

    // NYC's turn: its own 2s retire at its Run Routes end; at Purchase Trains its president offers for PRR's 2.
    state = advanceTo(state, "Hardware");
    expect(fleetOf(state, NYC)).toEqual(["3", "3"]);
    const offer = { seller_protocol_id: PRR, buyer_protocol_id: NYC, model_type: "2", price: "1" };
    expect(proposeTrainPurchaseRefusal(state, offer, P2, undefined)).toBe(EVERY_2("PRR"));
    expect(refused(state, PROPOSE(NYC, PRR, "2"), P2)).toBe(true);

    // C&O's turn: P1 presides over both C&O and PRR -- the direct sale is refused, atomically.
    state = advanceTo(send(state, PASS), "Hardware");
    expect(acting(state)).toBe(CO);
    expect(saleRefusal(state, CO, PRR, "2")).toBe(EVERY_2("PRR"));
    expect(S.ingress(state, P1, SALE(CO, PRR, "2"))).toBe(EVERY_2("PRR"));
    expectNothingMoved(state, dispatch(state, SALE(CO, PRR, "2"), P1));

    // An ordinary PRR train still sells (S5's shape from the seller's side): the 3 leaves; both marks stay home.
    state = send(state, SALE(CO, PRR, "3", "100"), P1);
    expect([fleetOf(state, PRR), marksOf(state, PRR)]).toEqual([["2", "2", "4"], ["2", "2"]]);
    expect([fleetOf(state, CO), marksOf(state, CO)]).toEqual([["3", "3", "3"], []]);
    expectMarksWithinFleets(state);

    // PRR's next turn is the grace turn: the two 2-trains it could not sell retire at its Run Routes end.
    state = send(state, PASS);
    expect([acting(state), state.sub_round_index]).toEqual([PRR, 2]);
    expect(fleetOf(state, PRR)).toEqual(["2", "2", "4"]);
    state = advanceTo(state, "Dividends");
    expect([fleetOf(state, PRR), marksOf(state, PRR)]).toEqual([["4"], []]);
    expectMarksWithinFleets(state);
  });

  it("S2 REPRESENTATION: a seller still carrying this turn's self-doom is refused by the Gentle Rust rule itself, and the doom list is not subtracted twice", () => {
    // REPRESENTATION: the cursor moved by hand to C&O's Purchase Trains step while PRR still carries its self-doom
    // (unreachable: only the operating corporation buys, and PRR's list is dropped when its turn ends).
    const s = rusted();
    const cursor = { ...s, active_corporation_index: s.active_operating_order.indexOf(CO) } as GameStateResponse;
    expect(saleRefusal(cursor, CO, PRR, "2")).toBe(EVERY_2("PRR"));
    expectNothingMoved(cursor, dispatch(cursor, SALE(CO, PRR, "2"), P1));
    expect(doomedOf(dispatch(cursor, SALE(CO, PRR, "2"), P1), PRR)).toEqual(["2", "2"]);

    // One more 2 at PRR, unmarked: owned 3 / marked 2 / doomed-this-turn 2 is ONE free copy, not none.
    const extra = S.withCorp(cursor, PRR, { owned_trains: ["2", "2", "3", "4", "2"] });
    expect(unreprievedCopiesOf(company(extra, PRR), "2")).toBe(1);
    expect(saleRefusal(extra, CO, PRR, "2")).toBeNull();
    const sold = send(extra, SALE(CO, PRR, "2", "5"), P1);
    expect([fleetOf(sold, PRR), marksOf(sold, PRR), doomedOf(sold, PRR)]).toEqual([["2", "3", "4", "2"], ["2", "2"], ["2", "2"]]);
    expect([fleetOf(sold, CO), marksOf(sold, CO)]).toEqual([["2", "3", "3", "2"], ["2"]]);
    expectMarksWithinFleets(sold);
    expect(saleRefusal(sold, CO, PRR, "2")).toBe(EVERY_2("PRR"));
    expectNothingMoved(sold, dispatch(sold, SALE(CO, PRR, "2", "5"), P1));
  });

  it("S3 REPRESENTATION: two identical copies, one reprieved -- exactly one sells, the mark stays home, a second sale is refused", () => {
    // REPRESENTATION: an ordinary 2 beside C&O's reprieved 2 (every copy of a doomed model is marked at once).
    const s = S.withCorp(rusted(), CO, { owned_trains: ["2", "2", "3"], pending_rust_trains: ["2"] });
    expect(saleRefusal(s, PRR, CO, "2")).toBeNull();
    const once = send(s, SALE(PRR, CO, "2", "10"), P1);
    expect([fleetOf(once, CO), marksOf(once, CO)]).toEqual([["2", "3"], ["2"]]);
    // The buyer receives an UNMARKED train: its own two marks are untouched, the bought copy is ordinary.
    expect([fleetOf(once, PRR), marksOf(once, PRR), doomedOf(once, PRR)]).toEqual([["2", "2", "3", "4", "2"], ["2", "2"], ["2", "2"]]);
    expect([treasuryOf(once, PRR), treasuryOf(once, CO)]).toEqual([treasuryOf(s, PRR) - 10, treasuryOf(s, CO) + 10]);
    expectMarksWithinFleets(once);
    // The copy left behind is the reprieved one.
    expect(saleRefusal(once, PRR, CO, "2")).toBe(SOLE_2_CO);
    expectNothingMoved(once, dispatch(once, SALE(PRR, CO, "2", "10"), P1));
  });

  it("S4 REPRESENTATION: three identical copies, two reprieved -- exactly one is saleable", () => {
    const s = S.withCorp(rusted(), CO, { owned_trains: ["2", "2", "2"], pending_rust_trains: ["2", "2"] });
    expect(unreprievedCopiesOf(company(s, CO), "2")).toBe(1);
    const once = send(s, SALE(PRR, CO, "2", "10"), P1);
    expect([fleetOf(once, CO), marksOf(once, CO)]).toEqual([["2", "2"], ["2", "2"]]);
    expectMarksWithinFleets(once);
    expect(saleRefusal(once, PRR, CO, "2")).toBe(EVERY_2("C&O"));
    expectNothingMoved(once, dispatch(once, SALE(PRR, CO, "2", "10"), P1));
  });

  it("S5: the seller's reprieve on ANOTHER model does not freeze an ordinary train -- it sells, and no mark travels", () => {
    const s = rusted();
    const after = send(s, SALE(PRR, CO, "3", "150"), P1);
    expect([fleetOf(after, CO), marksOf(after, CO)]).toEqual([["2", "3"], ["2"]]);
    expect([fleetOf(after, PRR), marksOf(after, PRR), doomedOf(after, PRR)]).toEqual([["2", "2", "3", "4", "3"], ["2", "2"], ["2", "2"]]);
    expect([treasuryOf(after, PRR), treasuryOf(after, CO)]).toEqual([treasuryOf(s, PRR) - 150, treasuryOf(s, CO) + 150]);
    expect(moneyTotal(after)).toBe(moneyTotal(s));
    expectMarksWithinFleets(after);
  });

  it("B: Gentle Rust on and nothing reprieved yet -- the ordinary sale is exactly as it was", () => {
    const before = saleStart();
    expect(saleRefusal(before, PRR, CO, "2", P1, "20")).toBeNull();
    const after = send(before, SALE(PRR, CO, "2", "20"), P1);
    expect([fleetOf(after, PRR), fleetOf(after, CO)]).toEqual([["2", "2", "3", "2"], ["3", "3"]]);
    expect(after.public_companies.every((entry) => (entry.pending_rust_trains ?? []).length === 0)).toBe(true);
  });

  it("S6: Gentle Rust off -- the rust is immediate, nothing is marked, and every ordinary sale is unchanged", () => {
    const plain = saleStart(false);
    expect(fleetOf(send(plain, SALE(PRR, CO, "2", "20"), P1), CO)).toEqual(["3", "3"]);
    const s = send(plain, BUY(PRR));
    expect([fleetOf(s, PRR), fleetOf(s, NYC), fleetOf(s, CO)]).toEqual([["3", "4"], ["3", "3"], ["3", "3"]]);
    expect(s.public_companies.every((entry) => (entry.pending_rust_trains ?? []).length === 0)).toBe(true);
    const sold = send(s, SALE(PRR, CO, "3", "150"), P1);
    expect([fleetOf(sold, PRR), fleetOf(sold, CO)]).toEqual([["3", "4", "3"], ["3"]]);
    expect(saleRefusal(s, PRR, CO, "2")).toBe("C&O does not own a 2-train to sell.");
  });

  it("S7: through a room (the server's path) the sale is refused with the rule's sentence and nothing is recorded", () => {
    const { room, submit, kinds } = S.roomFor(saleStart());
    expect(kinds(submit(P1, BUY(PRR)))).toEqual(["BuyHardwareFromPool"]);
    const seed = room.state;
    const logged = room.entries.length;

    const direct = submit(P1, SALE(PRR, CO, "2")) as { kind: string; reason?: string };
    expect([direct.kind, direct.reason]).toEqual(["refused", SOLE_2_CO]);
    const offered = submit(P1, PROPOSE(PRR, NYC, "2")) as { kind: string; reason?: string };
    expect([offered.kind, offered.reason]).toEqual(["refused", EVERY_2("NYC")]);
    expect(room.entries.length).toBe(logged);
    expect(stateDigest(room.state)).toBe(stateDigest(seed));

    // The ordinary train still sells through the same room (PRR is then at its limit of 3, so the room's Buy-Trains
    // auto-skip derives the turn's end -- ordinary behaviour, unchanged).
    expect(kinds(submit(P1, SALE(PRR, CO, "3", "150")))).toEqual(["BuyTrainFromCorporation", "PassTurn*"]);
    expect([fleetOf(room.state, CO), marksOf(room.state, CO)]).toEqual([["2", "3"], ["2"]]);
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expectMarksWithinFleets(room.state);
  });

  it("S7 replay: a stored sale of a reprieved train -- which the pre-GR-2 engine applied -- rebuilds as the no-op it now is", () => {
    // The room's own log for S7's accepted moves, with the refused sale spliced back in where a pre-GR-2 room
    // would have appended it.
    const entries = [
      S.entry(0, P1, BUY(PRR)),
      S.entry(1, P1, SALE(PRR, CO, "2")),
      S.entry(2, P1, SALE(PRR, CO, "3", "150")),
      S.entry(3, P1, PASS, true),
    ];
    const before = new Map<number, string>();
    const replayed = replayLog(entries, sandboxReplayProviders(), { state: saleStart(), waterfall: null }, ({ entry, stateBefore }) => {
      before.set(entry.index, stateDigest(stateBefore));
    });
    // Entry 1 changed nothing: the board entry 2 was handed is the board entry 1 was handed.
    expect(before.get(2)).toBe(before.get(1));
    expect([fleetOf(replayed.state, CO), marksOf(replayed.state, CO)]).toEqual([["2", "3"], ["2"]]);
    expect([fleetOf(replayed.state, PRR), marksOf(replayed.state, PRR)]).toEqual([["2", "2", "3", "4", "3"], ["2", "2"]]);
    expectMarksWithinFleets(replayed.state);
    // The same board the room reached by refusing the entry outright.
    const { room, submit } = S.roomFor(saleStart());
    submit(P1, BUY(PRR));
    submit(P1, SALE(PRR, CO, "2"));
    submit(P1, SALE(PRR, CO, "3", "150"));
    expect(room.entries.length).toBe(3);
    expect(stateDigest(replayed.state)).toBe(stateDigest(room.state));
  });

  it("S8: the Blood Price -- a gilded train on its final run is not for sale, so no Blood Price is charged and the curse stays", () => {
    const providers = sandboxReplayProviders();
    const GRID = S.GRID as MapGridResponse;
    const ctxFor = (state: GameStateResponse, msg: Msg, actor: string | null) =>
      sandboxActionContext(providers, { state, msg, actor, grid: GRID, gridBefore: GRID });
    const reduce = (state: GameStateResponse, msg: Msg, actor: string | null) => applySandboxAction(state, msg, ctxFor(state, msg, actor));
    const report = (state: GameStateResponse, msg: Msg, actor: string | null) => sandboxChartStepReport(state, msg, ctxFor(state, msg, actor));

    // C&O's 2-train is gilded (hand-set: the Yellow Sign's gift is not driven here); the first 4 then marks it for real.
    const gildedTwo = reduce(saleStart(true, ["2"]), BUY(PRR), P1);
    expect([fleetOf(gildedTwo, CO), marksOf(gildedTwo, CO), company(gildedTwo, CO).carcosan_trains]).toEqual([["2", "3", "3"], ["2"], ["2"]]);
    const sale = SALE(PRR, CO, "2", "150");
    expect(saleRefusal(gildedTwo, PRR, CO, "2", P1, "150")).toBe(SOLE_2_CO);
    const after = reduce(gildedTwo, sale, P1);
    expectNothingMoved(gildedTwo, after);
    expect(report(gildedTwo, sale, P1)).toBeNull();
    expect([company(after, CO).carcosan_trains, company(after, CO).is_carcosan]).toEqual([["2"], true]);

    // Control: the same harness DOES charge the Blood Price for a gilded ORDINARY train -- so the silence above is
    // the Gentle Rust refusal, not a harness that cannot see the chart.
    const gildedThree = reduce(saleStart(true, ["3"]), BUY(PRR), P1);
    const mark = gildedThree.market_positions![CO]!;
    const landed = projectBloodPriceMove(mark)!;
    const sold = reduce(gildedThree, SALE(PRR, CO, "3", "150"), P1);
    expect([sold.market_positions![CO]!.x, sold.market_positions![CO]!.y, sold.market_positions![CO]!.price]).toEqual([landed.x, landed.y, landed.price]);
    expect(report(gildedThree, SALE(PRR, CO, "3", "150"), P1)).toEqual({ companyId: CO, from: mark.price, to: landed.price, reason: "bloodPrice" });
    expect([fleetOf(sold, CO), marksOf(sold, CO), company(sold, CO).is_carcosan]).toEqual([["2", "3"], ["2"], false]);
    expectMarksWithinFleets(sold);
  });
});

/* ================================================================== */
/* D. OD-GR-2 -- no Diesel trade-in of a reprieved train              */
/* ================================================================== */

/** Phase 6 with both 6-trains out, so the Diesel is for sale and the first D -- bought or exchanged for -- rusts
 *  every 4-train. PRR operates first at its Purchase Trains step. */
const dieselStart = (prr: string[], extra: Partial<Parameters<typeof board>[0]> = {}) =>
  board({
    corps: [{ id: PRR, trains: prr }, { id: NYC, trains: ["6", "6"] }, { id: BO, trains: ["4"] }],
    operating: PRR,
    ...extra,
  });
const SOLE_4 = (ticker: string) => `${ticker}'s 4-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.`;
const ONLY_ELIGIBLE = (ticker: string) =>
  `${ticker}'s only 4-, 5- or 6-train is on its Gentle Rust final run — it cannot be traded in for a Diesel.`;

describe("D. OD-GR-2: a reprieved train may not be traded in for a Diesel", () => {
  it("D5 + D2 + D9 (probe P9 closed): an ordinary 4 trades in for the FIRST Diesel with no look-ahead; the 4 that rust then marks is refused, atomically", () => {
    const before = dieselStart(["4", "4"]);
    headIs(before, "D");
    // Judged on the board before the purchase: both 4s are ordinary, both are candidates.
    expect(exchangeableTrains(company(before, PRR))).toEqual(["4", "4"]);
    expect(dieselExchangeRefusal(before, PRR, "4")).toBeNull();

    const traded = send(before, EXCHANGE(PRR, "4"));
    expect(derivePhase(traded)?.tier).toBe("D");
    // One 4 exchanged (gone, then scrapped from the pool by the same rust sweep, #1314); the other doomed in PRR's
    // own turn; B&O's doomed for its later turn.
    expect([fleetOf(traded, PRR), marksOf(traded, PRR), doomedOf(traded, PRR)]).toEqual([["4", "D"], ["4"], ["4"]]);
    expect([fleetOf(traded, BO), marksOf(traded, BO), doomedOf(traded, BO)]).toEqual([["4"], ["4"], undefined]);
    expect(traded.returned_trains).toEqual([]);
    expect(treasuryOf(traded, PRR)).toBe(3000 - DIESEL_EXCHANGE_COST);
    expect(Number(traded.virtual_bank_vgp)).toBe(12000 + DIESEL_EXCHANGE_COST);
    expectMarksWithinFleets(traded);

    // The second 4 is now reprieved -- and doomed this turn: no candidate, the named refusal, the panel's refusal.
    expect(exchangeableTrains(company(traded, PRR))).toEqual([]);
    expect(dieselExchangeRefusal(traded, PRR, "4")).toBe(SOLE_4("PRR"));
    expect(dieselExchangeRefusal(traded, PRR)).toBe(ONLY_ELIGIBLE("PRR"));
    // D9: no treasury debit, no Diesel, no returned train, no phase transition, no mark moved.
    const after = dispatch(traded, EXCHANGE(PRR, "4"));
    expectNothingMoved(traded, after);
    expect(fleetOf(after, PRR).filter((model) => model === "D")).toHaveLength(1);
    // The shell's REFUSED line asks the same gate on the same board.
    expect(actionWasRefused(traded, after, EXCHANGE(PRR, "4"))).toBe(true);
    expect(refusalReasonFor(traded, EXCHANGE(PRR, "4"))).toBe(SOLE_4("PRR"));
  });

  it("D1 REPRESENTATION: a requested 4 that is reprieved but NOT doomed this turn is refused the same way", () => {
    // REPRESENTATION: the self-doom record dropped by hand -- a rival-doomed train is retired at its owner's Run
    // Routes end, before that owner's Purchase Trains step, so play never shows it here.
    const traded = send(dieselStart(["4", "4"]), EXCHANGE(PRR, "4"));
    const rivalDoomed = S.withCorp(traded, PRR, { pending_rust_doomed_this_turn: undefined });
    expect(dieselExchangeRefusal(rivalDoomed, PRR, "4")).toBe(SOLE_4("PRR"));
    expectNothingMoved(rivalDoomed, dispatch(rivalDoomed, EXCHANGE(PRR, "4")));
  });

  it("D3 / D10 REPRESENTATION: one ordinary and one reprieved 4 -- exactly one candidate; after one exchange the reprieved copy remains, marked, and cannot follow", () => {
    // Pure candidate generation (D10).
    expect(exchangeableTrains({ owned_trains: ["4", "4", "5"], pending_rust_trains: ["4"] })).toEqual(["4", "5"]);
    expect(exchangeableTrains({ owned_trains: ["4", "4"], pending_rust_trains: ["4"] })).toEqual(["4"]);
    expect(exchangeableTrains({ owned_trains: ["4", "4"], pending_rust_trains: ["4", "4"] })).toEqual([]);
    expect(exchangeableTrains({ owned_trains: ["4", "4"], pending_rust_trains: ["4"], pending_rust_doomed_this_turn: ["4"] } as never)).toEqual(["4"]);
    expect(exchangeableTrains({ owned_trains: ["2", "3", "D"] })).toEqual([]);
    expect(exchangeableTrains(null)).toEqual([]);

    // Through the reducer. REPRESENTATION: an ordinary 4 added beside PRR's self-doomed 4 after the first Diesel.
    const traded = send(dieselStart(["4", "4"]), EXCHANGE(PRR, "4"));
    const mixed = S.withCorp(traded, PRR, { owned_trains: ["4", "D", "4"] });
    expect(exchangeableTrains(company(mixed, PRR))).toEqual(["4"]);
    expect(dieselExchangeRefusal(mixed, PRR, "4")).toBeNull();
    const once = send(mixed, EXCHANGE(PRR, "4"));
    expect([fleetOf(once, PRR), marksOf(once, PRR), doomedOf(once, PRR)]).toEqual([["D", "4", "D"], ["4"], ["4"]]);
    // The ordinary copy went to the Bank Pool (the phase did not change, so nothing scraps it there); no mark went with it.
    expect(once.returned_trains).toEqual(["4"]);
    expect(treasuryOf(once, PRR)).toBe(treasuryOf(mixed, PRR) - DIESEL_EXCHANGE_COST);
    expectMarksWithinFleets(once);
    expect(exchangeableTrains(company(once, PRR))).toEqual([]);
    expect(dieselExchangeRefusal(once, PRR, "4")).toBe(SOLE_4("PRR"));
    expectNothingMoved(once, dispatch(once, EXCHANGE(PRR, "4")));
  });

  it("D4: a reprieved 4 beside an ordinary 5 -- the 4 is excluded and refused, the 5 still trades in", () => {
    // PRR buys the first Diesel outright (its 4 is doomed in its own turn), then a 5 from the Bank Pool.
    let state = dieselStart(["4"], { returned: ["5"] });
    state = send(state, BUY(PRR));
    expect([fleetOf(state, PRR), marksOf(state, PRR), doomedOf(state, PRR)]).toEqual([["4", "D"], ["4"], ["4"]]);
    state = send(state, BUY_RETURNED(PRR, "5"));
    expect([fleetOf(state, PRR), state.returned_trains]).toEqual([["4", "D", "5"], []]);

    expect(exchangeableTrains(company(state, PRR))).toEqual(["5"]);
    expect(dieselExchangeRefusal(state, PRR)).toBeNull(); // an exchange IS available -- through the 5
    expect(dieselExchangeRefusal(state, PRR, "4")).toBe(SOLE_4("PRR"));
    expectNothingMoved(state, dispatch(state, EXCHANGE(PRR, "4")));

    const traded = send(state, EXCHANGE(PRR, "5"));
    expect([fleetOf(traded, PRR), marksOf(traded, PRR), doomedOf(traded, PRR)]).toEqual([["4", "D", "D"], ["4"], ["4"]]);
    expect(traded.returned_trains).toEqual(["5"]);
    expect(treasuryOf(traded, PRR)).toBe(treasuryOf(state, PRR) - DIESEL_EXCHANGE_COST);
    expectMarksWithinFleets(traded);
    expect(dieselExchangeRefusal(traded, PRR)).toBe(ONLY_ELIGIBLE("PRR"));
  });

  it("D6: ordinary 5 and 6 trade-ins are unchanged under Gentle Rust, the first Diesel and a later one alike", () => {
    // A 5 for the first Diesel: PRR keeps no mark (the traded 5 is not a doomed tier); B&O's 4 is doomed.
    const five = send(dieselStart(["5", "5"]), EXCHANGE(PRR, "5"));
    expect([fleetOf(five, PRR), marksOf(five, PRR), five.returned_trains]).toEqual([["5", "D"], [], ["5"]]);
    expect(marksOf(five, BO)).toEqual(["4"]);
    expect(treasuryOf(five, PRR)).toBe(3000 - DIESEL_EXCHANGE_COST);
    expectMarksWithinFleets(five);

    // A 6 for a LATER Diesel, by a corporation holding no reprieve, while B&O's reprieved 4 waits for its turn.
    let state = board({
      corps: [{ id: NYC, trains: ["6"] }, { id: PRR, trains: ["6"] }, { id: BO, trains: ["4"] }],
      operating: NYC,
    });
    state = send(state, BUY(NYC, "D"));
    expect(marksOf(state, BO)).toEqual(["4"]);
    state = advanceTo(send(state, PASS), "Hardware");
    expect(acting(state)).toBe(PRR);
    const six = send(state, EXCHANGE(PRR, "6"));
    expect([fleetOf(six, PRR), six.returned_trains, treasuryOf(six, PRR)]).toEqual([["D"], ["6"], 3000 - DIESEL_EXCHANGE_COST]);
    expect([fleetOf(six, BO), marksOf(six, BO)]).toEqual([["4"], ["4"]]);
    expectMarksWithinFleets(six);
  });

  it("D16: the ordinary gates are unchanged on a Gentle Rust table -- availability, funds, step and actor", () => {
    const gentle = dieselStart(["4", "4"]);
    const early = board({ corps: [{ id: PRR, trains: ["4", "4"] }, { id: NYC, trains: ["5", "5"] }], operating: PRR });
    expect(dieselExchangeRefusal(early, PRR, "4")).toBe("D-trains are not for sale yet — the first 6-train must be bought first.");
    expect(dieselExchangeRefusal(S.withCorp(gentle, PRR, { treasury: "700" }), PRR, "4")).toMatch(/cannot pay \$800/);
    expect(dieselExchangeRefusal({ ...gentle, operating_sub_phase: "Track" } as GameStateResponse, PRR, "4")).toMatch(/Buy Trains step/);
    expect(dieselExchangeRefusal(gentle, NYC, "6")).toMatch(/Only the operating corporation/);
    expect(dieselExchangeRefusal(gentle, PRR, "3")).toBe("PRR holds no 3-train to trade in.");
    for (const [state, msg] of [
      [early, EXCHANGE(PRR, "4")],
      [S.withCorp(gentle, PRR, { treasury: "700" }), EXCHANGE(PRR, "4")],
      [{ ...gentle, operating_sub_phase: "Track" } as GameStateResponse, EXCHANGE(PRR, "4")],
    ] as Array<[GameStateResponse, Msg]>) {
      expect(refused(state, msg)).toBe(true);
    }
  });

  it("D7 / D8: the Level Playing Field's $750 trade-in -- ordinary 4 unchanged, reprieved 4 refused, the $900 outright Diesel untouched", () => {
    const lpf = (prr: string[], rival: string[]) =>
      board({ corps: [{ id: PRR, trains: prr }, { id: NYC, trains: rival }], operating: PRR, lpf: true, homeless: true });

    // D7: an ordinary 4 for the first Diesel at $750; NYC's 4 is doomed.
    const ordinary = lpf(["6", "4"], ["4"]);
    expect(dieselExchangeCostFor(ordinary)).toBe(LPF_DIESEL_EXCHANGE_COST);
    expect(dieselExchangeRefusal(ordinary, PRR, "4")).toBeNull();
    const traded = send(ordinary, EXCHANGE(PRR, "4"));
    expect([fleetOf(traded, PRR), marksOf(traded, PRR), treasuryOf(traded, PRR)]).toEqual([["6", "D"], [], 3000 - 750]);
    expect(marksOf(traded, NYC)).toEqual(["4"]);
    expectMarksWithinFleets(traded);

    // D8: PRR buys the first Diesel outright at the LPF's $900, dooming its own 4, which then cannot earn the $750.
    const bought = send(lpf(["4"], ["6"]), BUY(PRR, "D"));
    expect([fleetOf(bought, PRR), marksOf(bought, PRR), treasuryOf(bought, PRR)]).toEqual([["4", "D"], ["4"], 3000 - 900]);
    expect(dieselExchangeRefusal(bought, PRR, "4")).toBe(SOLE_4("PRR"));
    expect(exchangeableTrains(company(bought, PRR))).toEqual([]);
    expectNothingMoved(bought, dispatch(bought, EXCHANGE(PRR, "4")));
  });

  it("D (room, probe P9's exact move): the first Diesel bought outright, then the doomed 4 offered as a trade-in -- refused with the gate's sentence, nothing recorded", () => {
    const { room, submit, kinds } = S.roomFor(dieselStart(["4"]));
    expect(kinds(submit(P1, BUY(PRR)))).toEqual(["BuyHardwareFromPool"]);
    expect([fleetOf(room.state, PRR), marksOf(room.state, PRR)]).toEqual([["4", "D"], ["4"]]);
    const seed = room.state;
    const logged = room.entries.length;
    const second = submit(P1, EXCHANGE(PRR, "4")) as { kind: string; reason?: string };
    expect([second.kind, second.reason]).toEqual(["refused", SOLE_4("PRR")]);
    expect(room.entries.length).toBe(logged);
    expect(stateDigest(room.state)).toBe(stateDigest(seed));
    expect(moneyTotal(room.state)).toBe(moneyTotal(seed));
    expect(room.state.returned_trains).toEqual([]);
  });
});

/* ================================================================== */
/* X. Excess discard -- regression only (SR-8, probe P7)              */
/* ================================================================== */

describe("X. the excess discard is undisturbed: a reprieved train occupies no slot and is never a choice", () => {
  it("a rival's first 5 leaves PRR over the limit with its self-doomed 2 still owed its next turn: the 2 is not a choice, a discard moves no mark", () => {
    // Every mark real: PRR buys the first 4 AND a second (its 2 doomed in its own turn), NYC buys the last two 4s,
    // C&O buys the first 5 (limit 2). The pool holds the 2s and 3s the fleets do not, so every depot head is real.
    let state = board({
      corps: [{ id: PRR, trains: ["2", "3"] }, { id: NYC, trains: ["3"] }, { id: CO, trains: ["3"] }],
      operating: PRR,
      returned: ["2", "2", "2", "2", "2", "3", "3"],
    });
    headIs(state, "4");
    state = send(send(state, BUY(PRR)), BUY(PRR));
    expect([fleetOf(state, PRR), marksOf(state, PRR), doomedOf(state, PRR)]).toEqual([["2", "3", "4", "4"], ["2"], ["2"]]);
    state = advanceTo(send(state, PASS), "Hardware");
    state = send(send(state, BUY(NYC)), BUY(NYC));
    state = advanceTo(send(state, PASS), "Hardware");
    expect(acting(state)).toBe(CO);
    headIs(state, "5");
    state = send(state, BUY(CO));
    expect(derivePhase(state)?.trainLimit).toBe(2);

    const owed = pendingTrainDiscards(state)!;
    const prr = owed.queue.find((due) => due.companyId === PRR)!;
    expect([prr.excess, [...prr.choices]]).toEqual([1, ["3", "4", "4"]]);
    expect(marksOf(state, PRR)).toEqual(["2"]);

    // PRR decides first (the higher share value). The reprieved 2 is refused; the 3 goes to the Bank Pool.
    expect(owed.required.companyId).toBe(PRR);
    expect(discardTrainRefusal(state, { protocol_id: PRR, model_type: "2" }, P1)).toBe("PRR holds no 2-train it could discard.");
    expect(refused(state, DISCARD(PRR, "2"), P1)).toBe(true);
    const discarded = send(state, DISCARD(PRR, "3"), P1);
    expect([fleetOf(discarded, PRR), marksOf(discarded, PRR)]).toEqual([["2", "4", "4"], ["2"]]);
    expect(discarded.returned_trains).toEqual([...(state.returned_trains ?? []), "3"]);
    expectMarksWithinFleets(discarded);
  });
});
