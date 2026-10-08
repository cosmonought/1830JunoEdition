// frontend/src/tutorial/triggers.test.ts -- PHASE 3 FINAL PLAY TUTORIAL: play triggers (CONTEXT).
//
// The deal and the auction are driven through the REAL room engine (`RoomSession`, the server's own), so the boards
// these triggers read are the boards the shell reads. Later rounds are reached by editing a real board -- the triggers
// are pure functions of two boards and a message, so an edited board is a fair input.

import { RoomSession } from "../utils/roomSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } from "../gameEngine/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../gameEngine/gameSetup";
import { actingAddress, type GameStateResponse } from "../gameEngine/gameState";
import {
  decisionLessons,
  eventLessons,
  lessonRelevant,
  lessonsForTransition,
  waitingRoomLessons,
} from "./triggers";

const BUILD = "tutorial-test";
const OWNER = "p-owner";
const BEA = "p-bea";
const SETUP = { SetupGame: { players: [{ id: OWNER, nickname: "Owner" }, { id: BEA, nickname: "Bea" }], variants: {} } };

function room(): RoomSession {
  let n = 0;
  return new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
  });
}

function submit(session: RoomSession, actor: string, msg: unknown): void {
  const answer = session.submit({ actor, build: BUILD, msg: msg as never, baseIndex: session.nextIndex - 1 }) as { kind: string };
  if (answer.kind !== "applied") throw new Error(`refused: ${JSON.stringify(answer)}`);
}

/** A dealt two-player board, before and after the deal. */
function dealt() {
  const session = room();
  const seeded = session.state;
  submit(session, OWNER, SETUP);
  return { session, seeded, after: session.state };
}

const ids = (raised: readonly { id: string }[]) => raised.map((entry) => entry.id);

describe("the deal: orientation, then the opening round's primer and the first decision", () => {
  it("raises the two orientation cards, the auction primer and -- for the seat to act -- its choices", () => {
    const { seeded, after } = dealt();
    expect(after.current_round_type).toBe("WaterfallAuction");
    const first = actingAddress(after, after.waterfall ?? null);
    expect([OWNER, BEA]).toContain(first);
    expect(ids(lessonsForTransition({ before: seeded, after, msg: SETUP, viewer: first! }))).toEqual([
      "orientation.goal",
      "orientation.flow",
      "auction.primer",
      "auction.choices",
    ]);
    const other = first === OWNER ? BEA : OWNER;
    expect(ids(lessonsForTransition({ before: seeded, after, msg: SETUP, viewer: other }))).toEqual([
      "orientation.goal",
      "orientation.flow",
      "auction.primer",
    ]);
  });

  it("a Delayed Auction deal opens on a Stock Round, so its primer is the Stock Round's", () => {
    const { seeded, after } = dealt();
    const stock = { ...after, current_round_type: "StockRound" } as GameStateResponse;
    expect(ids(lessonsForTransition({ before: seeded, after: stock, msg: SETUP, viewer: "nobody" }))).toEqual([
      "orientation.goal",
      "orientation.flow",
      "stock.primer",
    ]);
  });
});

describe("the auction's events", () => {
  it("everyone passing in a row is the all-pass lesson", () => {
    const { session } = dealt();
    let before = session.state;
    let raised: string[] = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const actor = actingAddress(session.state, session.state.waterfall ?? null)!;
      before = session.state;
      submit(session, actor, { WaterfallPass: { game_id: 0 } });
      raised = ids(eventLessons(before, session.state, { WaterfallPass: { game_id: 0 } }));
    }
    expect(raised).toContain("auction.allPass");
  });

  it("a contest opening, or more than one company settling at once, is the cascade", () => {
    const { after } = dealt();
    const contest = {
      ...after,
      waterfall: { ...after.waterfall!, mini_auction: { private_id: 2, bidders: [OWNER, BEA], current_turn: OWNER, high_bid: "45", high_bidder: BEA } },
    } as GameStateResponse;
    expect(ids(eventLessons(after, contest, { WaterfallBuyLowest: { game_id: 0 } }))).toContain("auction.cascade");
    const twoSold = { ...after, waterfall: { ...after.waterfall!, privates: after.waterfall!.privates.slice(2) } } as GameStateResponse;
    expect(ids(eventLessons(after, twoSold, { WaterfallBuyLowest: { game_id: 0 } }))).toContain("auction.cascade");
    const oneSold = { ...after, waterfall: { ...after.waterfall!, privates: after.waterfall!.privates.slice(1) } } as GameStateResponse;
    expect(ids(eventLessons(after, oneSold, { WaterfallBuyLowest: { game_id: 0 } }))).not.toContain("auction.cascade");
  });
});

/* ---------------------------------------------------------------- later rounds, on edited real boards */

function stockRound(after: GameStateResponse, actingIndex: number): GameStateResponse {
  return { ...after, current_round_type: "StockRound", active_player_index: actingIndex, waterfall: null } as GameStateResponse;
}

function withCompany(state: GameStateResponse, companyId: number, patch: Record<string, unknown>): GameStateResponse {
  return {
    ...state,
    public_companies: state.public_companies.map((company) => (company.company_id === companyId ? { ...company, ...patch } : company)),
  } as GameStateResponse;
}

describe("the Stock Round", () => {
  it("opening it raises its primer, and closing it the round-end lesson", () => {
    const { after } = dealt();
    const sr = stockRound(after, 1);
    expect(ids(lessonsForTransition({ before: after, after: sr, msg: { WaterfallBuyLowest: {} }, viewer: "nobody" }))).toEqual(["stock.primer"]);
    const or = { ...sr, current_round_type: "OperatingRound", active_operating_order: [], active_corporation_index: 0 } as GameStateResponse;
    expect(ids(lessonsForTransition({ before: sr, after: or, msg: { PassTurn: {} }, viewer: "nobody" }))).toEqual([
      "stock.roundEnd",
      "operating.primer",
      "stock.passing",
    ]);
  });

  it("the viewer's turn is the decision: the turn lesson, and par while a corporation is unstarted", () => {
    const { after } = dealt();
    const sr = stockRound(after, after.player_addresses.indexOf(BEA));
    expect(decisionLessons(sr, BEA)).toEqual(["stock.turn", "stock.par"]);
    expect(decisionLessons(sr, OWNER)).toEqual([]);
    const allParred = {
      ...sr,
      public_companies: sr.public_companies.map((company) => ({ ...company, par_value: "67" })),
    } as GameStateResponse;
    expect(decisionLessons(allParred, BEA)).toEqual(["stock.turn"]);
  });

  it("par, float, presidency and a sale are each their event", () => {
    const { after } = dealt();
    const sr = stockRound(after, 0);
    const id = sr.public_companies[0].company_id;
    const parred = withCompany(sr, id, { par_value: "67", president: OWNER });
    expect(eventLessons(sr, parred, { BuyStock: {} })).toContainEqual({ id: "stock.par", subject: id });
    const floated = withCompany(parred, id, { is_floated: true });
    expect(eventLessons(parred, floated, { BuyStock: {} })).toContainEqual({ id: "stock.float", subject: id });
    const handedOver = withCompany(floated, id, { president: BEA });
    expect(eventLessons(floated, handedOver, { BuyStock: {} })).toContainEqual({ id: "stock.presidency", subject: id });
    expect(ids(eventLessons(floated, handedOver, { SellStock: {} }))).toContain("stock.selling");
    // A refused sale (the reducer hands back the same board) teaches nothing.
    expect(ids(eventLessons(floated, floated, { SellStock: {} }))).not.toContain("stock.selling");
  });
});

describe("the Operating Round", () => {
  function operating(after: GameStateResponse, step: string, trains: string[]): GameStateResponse {
    const id = after.public_companies[0].company_id;
    const withPresident = withCompany(after, id, { president: OWNER, is_floated: true, par_value: "67", owned_trains: trains });
    return {
      ...withPresident,
      current_round_type: "OperatingRound",
      active_operating_order: [id],
      active_corporation_index: 0,
      operating_sub_phase: step,
      waterfall: null,
    } as GameStateResponse;
  }

  it("each step is a decision for the operating corporation's president only", () => {
    const { after } = dealt();
    expect(decisionLessons(operating(after, "Track", []), OWNER)).toEqual(["operating.track"]);
    expect(decisionLessons(operating(after, "Tokens", []), OWNER)).toEqual(["operating.tokens"]);
    expect(decisionLessons(operating(after, "Routes", ["2"]), OWNER)).toEqual(["operating.routes"]);
    expect(decisionLessons(operating(after, "Routes", []), OWNER)).toEqual([]); // skipped: no train to run
    expect(decisionLessons(operating(after, "Dividends", ["2"]), OWNER)).toEqual(["operating.dividends"]);
    expect(decisionLessons(operating(after, "Dividends", []), OWNER)).toEqual([]); // the forced $0 withhold: no decision
    expect(decisionLessons(operating(after, "Hardware", []), OWNER)).toEqual(["operating.trains"]);
    expect(decisionLessons(operating(after, "Track", []), BEA)).toEqual([]);
  });

  it("a price move is the market lesson about that corporation; a trainless withhold is the first-turn lesson", () => {
    const { after } = dealt();
    const or = operating(after, "Dividends", []);
    const id = or.public_companies[0].company_id;
    const at = (price: number) => ({ ...or, market_positions: { ...(or.market_positions ?? {}), [id]: { price, x: 3, y: 3 } } }) as GameStateResponse;
    const raised = eventLessons(at(67), at(65), { DeclareDividends: {} });
    expect(raised).toContainEqual({ id: "market.firstWithhold", subject: id });
    expect(ids(raised)).not.toContain("market.moves"); // one move, one card
    // A share sold during an emergency moves the price for another reason: the general lesson, not the withhold one.
    const sold = eventLessons(at(67), at(65), { SellStock: {} });
    expect(ids(sold)).toEqual(expect.arrayContaining(["market.moves"]));
    expect(ids(sold)).not.toContain("market.firstWithhold");
    const rose = eventLessons(at(67), at(71), { DeclareDividends: {} });
    expect(rose).toContainEqual({ id: "market.moves", subject: id });
    expect(ids(rose)).not.toContain("market.firstWithhold");
  });

  it("a new phase, and the trains it rusted", () => {
    const { after } = dealt();
    const base = operating(after, "Hardware", ["2", "2", "3"]);
    const id = base.public_companies[0].company_id;
    const phaseFour = withCompany(base, id, { owned_trains: ["3", "4"] });
    const raised = ids(eventLessons(base, phaseFour, { BuyHardwareFromPool: {} }));
    expect(raised).toContain("trains.phases");
    expect(raised).toContain("trains.rust");
    const same = withCompany(base, id, { owned_trains: ["2", "2", "3", "3"] });
    expect(ids(eventLessons(base, same, { BuyHardwareFromPool: {} }))).not.toContain("trains.phases");
  });
});

describe("relevance: a decision lesson needs its decision; a primer needs its round", () => {
  it("withdraws what no longer stands and keeps what happened", () => {
    const { after } = dealt();
    const first = actingAddress(after, after.waterfall ?? null)!;
    const other = first === OWNER ? BEA : OWNER;
    expect(lessonRelevant("auction.choices", after, first)).toBe(true);
    expect(lessonRelevant("auction.choices", after, other)).toBe(false);
    expect(lessonRelevant("auction.primer", after, other)).toBe(true);
    expect(lessonRelevant("stock.primer", after, other)).toBe(false);
    expect(lessonRelevant("stock.float", after, other)).toBe(true);
    expect(lessonRelevant("orientation.goal", null, other)).toBe(true);
    expect(lessonRelevant({ id: "stock.par", subject: 3 }, after, other)).toBe(true); // somebody else's par: an event
  });

  it("before the deal -- the waiting room, or a reload still catching up -- board lessons are UNKNOWN, never withdrawn", () => {
    const { seeded, after } = dealt();
    expect(seeded.player_addresses).toEqual([]);
    expect(lessonRelevant("market.moves", null, OWNER)).toBe("unknown");
    expect(lessonRelevant("auction.choices", seeded, OWNER)).toBe("unknown");
    expect(lessonRelevant("stock.primer", seeded, OWNER)).toBe("unknown");
    // The waiting room's own lessons belong before the deal, and only then.
    expect(lessonRelevant("money.ante", seeded, OWNER)).toBe(true);
    expect(lessonRelevant("pace.modes", null, OWNER)).toBe(true);
    expect(lessonRelevant("money.ante", after, OWNER)).toBe(false);
  });
});

describe("the waiting room teaches the table's own terms", () => {
  it("money tables get the ante lesson, clocked tables the pace lesson", () => {
    expect(waitingRoomLessons({ money: true, clocked: true })).toEqual(["money.ante", "pace.modes"]);
    expect(waitingRoomLessons({ money: false, clocked: false })).toEqual([]);
  });
});
