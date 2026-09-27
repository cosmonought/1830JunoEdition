/** @jest-environment node */
//
// ==================================================================
//  RR2A-F1: `BeginOperatingRound` ESCAPED THE PRIVATE COMPANY AUCTION (Phase 2A, before DA-7)
// ==================================================================
//
// `claude/rust-retire-2a-harvest-2026-09-26.md` §8: on a pinned board the seat the auction was waiting on could send
// `BeginOperatingRound` mid-auction, and the room answered `applied` -- the round became `OperatingRound` with an
// empty queue while the auction atom stayed open and stranded. Every case marked (F) below FAILED on `0ae252d`, in the
// standard game and under the Delayed Auction. The same probe found the auction's one other stray, a Stock Round /
// Operating Round `PassTurn` committed mid-auction (a junk entry, no escape) -- closed by the same predicate.
//
// Refusals are asserted at BOTH locks -- ingress (`turnRefusal`) and the reducer, BY IDENTITY -- and through the room,
// where a refusal appends nothing and moves no digest. The legitimate way into an Operating Round (the Stock Round's
// closing passes) is asserted alongside, in both games, so a gate that refused everything could not pass.

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;
type Room = InstanceType<typeof import("./roomSession").RoomSession>;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { applySandboxAction, operatingRoundSequenceLength } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { actingAddress } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { refusalReasonFor } = require("./refusedAction") as typeof import("./refusedAction");
const RT = require("../gameEngine/roundTransitionAuthority") as typeof import("../gameEngine/roundTransitionAuthority");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");

const A = "p-rr2a-a01";
const B = "p-rr2a-b02";
const C = "p-rr2a-c03";
const BO = 6;
const DH = 3;
const BUILD = "b-rr2a";

const SETUP = (delayed: boolean) => ({
  SetupGame: {
    players: [
      { id: A, nickname: "A" },
      { id: B, nickname: "B" },
      { id: C, nickname: "C" },
    ],
    variants: { delayedAuction: delayed, length: "standard", rules: 1 },
  },
});
const BEGIN_OR = { BeginOperatingRound: { game_id: 0 } };
const PASS_TURN = { PassTurn: { game_id: 0 } };
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const BID = (privateId: number, amount: number) => ({ WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) } });
const MINI_RAISE = (amount: number) => ({ WaterfallMiniAuctionRaise: { game_id: 0, bid_amount: String(amount) } });
const OPEN = { OpenStockRound: {} };
const PAR = (player: string) => ({ SetBoPar: { player, par_value: "100" } });

const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});
let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `rr2a-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];
const boardOf = (engine: Engine): State => ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const ownerOf = (board: State, id: number) => board.private_companies.find((p) => p.private_id === id)?.owner ?? null;

function roomFrom(start?: { state: State; waterfall: State["waterfall"] | null }): Room {
  let n = 0;
  return new RoomSession({ providers: sandboxReplayProviders(), seed: (start ?? seed()) as never, build: BUILD, mintId: () => `m${(n += 1)}` });
}
const submit = (room: Room, actor: string, msg: unknown, extra: Record<string, unknown> = {}) =>
  room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A, ...extra } as never);
function applied(room: Room, actor: string, msg: unknown) {
  const answer = submit(room, actor, msg);
  if (answer.kind !== "applied") throw new Error(`${Object.keys(msg as object)[0]} by ${actor} was ${answer.kind}: ${JSON.stringify(answer)}`);
}

/* ---- the two games, each PINNED by the room that dealt it (#1520) ------------------------------------------ */

/** A standard game dealt through the room: the auction is open on the Priority Deal holder. */
function standardRoom(): Room {
  const room = roomFrom();
  applied(room, A, SETUP(false));
  // DA-8: was `toBe(10)`; the room pins the current engine (v11 since DA-8). RR2A-F1 asks presence, not the value.
  expect(room.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
  expect(room.state.current_round_type).toBe("WaterfallAuction");
  expect(room.state.waterfall?.waterfall_auction_active).toBe(true);
  return room;
}

/** A Delayed Auction armed by the set's end, as DA-4 builds it (`da4AuctionPriorityDeal.test.ts`): a real Stock Round
 *  1, the first 3-train's set hand-built at its last turn, the set ended through the engine -- then PINNED, and the
 *  room seeded on that board, warmed by one legal bid so the room's first entry is not the one that reconciles the
 *  hand-built chart marks. */
function delayedArmedBoard(): State {
  const send = (engine: Engine, actor: string, msg: unknown) => {
    const board = boardOf(engine);
    expect(turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor, msg: msg as never })).toBeNull();
    engine.apply(entry(actor, msg));
  };
  const engine = new RL.RoomEngine(sandboxReplayProviders(), seed() as never);
  engine.apply(entry(A, SETUP(true)));
  const prr = boardOf(engine).public_companies.find((company) => company.ticker === "PRR")!;
  send(engine, A, PASS_TURN);
  send(engine, A, { BuyStock: { game_id: 0, protocol_id: prr.company_id, source: "Ipo", par_value: "100" } });
  send(engine, A, PASS_TURN);
  for (let guard = 0; boardOf(engine).macro_round_number === 1; guard += 1) {
    if (guard > 8) throw new Error("Stock Round 1 did not end");
    send(engine, seatOf(boardOf(engine)), PASS_TURN);
  }
  const real = boardOf(engine);
  const nyc = real.public_companies.find((company) => company.ticker === "NYC")!;
  const orEnd = {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(C),
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? { ...company, is_floated: true, president: C, par_value: "100", owned_trains: ["2", "3"],
            player_holdings: [{ player: C, percentage: 60 }], ipo_pool_percentage: 40, station_token_hexes: ["G19"] }
        : company,
    ),
  } as State;
  const armed = new RL.RoomEngine(sandboxReplayProviders(), { state: orEnd, waterfall: orEnd.waterfall ?? null } as never);
  send(armed, C, PASS_TURN);
  const board = boardOf(armed);
  expect(board.current_round_type).toBe("WaterfallAuction");
  expect(board.waterfall?.waterfall_auction_active).toBe(true);
  return { ...board, rules_engine_version: RULES_ENGINE_VERSION } as State; // DA-8: the current pin (was the literal 10)
}
function delayedRoom(): Room {
  const armed = delayedArmedBoard();
  const room = roomFrom({ state: armed, waterfall: armed.waterfall ?? null });
  applied(room, actorOf(room.state), BID(DH, 75));
  return room;
}

const GAMES: Array<[string, () => Room]> = [
  ["standard", standardRoom],
  ["Delayed Auction", delayedRoom],
];

/* ---- what "nothing moved" means ------------------------------------------------------------------------------ */

/** Every field the brief names: the auction, the round, and the turn / Priority Deal. */
const pointers = (board: State) => ({
  round: board.current_round_type,
  macro: board.macro_round_number,
  sub: board.sub_round_index,
  order: board.active_operating_order,
  corporation: board.active_corporation_index,
  seat: board.active_player_index,
  priorityDeal: board.priority_deal_index,
  passes: board.consecutive_passes,
  stage: board.stock_turn_stage ?? null,
  auction: board.waterfall ?? null,
  complete: board.private_auction_complete ?? null,
});

/** The refusal at both locks, then through the room: a stable sentence, the reducer's board BY IDENTITY, no entry,
 *  no digest move, and every auction / round / turn pointer as it was. */
function expectRefusedEverywhere(room: Room, sender: string, msg: unknown, sentence: string) {
  const board = room.state;
  const ingress = turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor: sender, msg: msg as never });
  expect(ingress).toBe(sentence);
  expect(applySandboxAction(board, msg as never, { actor: sender } as never)).toBe(board);
  expect(refusalReasonFor(board, msg as never, { actor: sender })).toBe(sentence);

  const before = { log: room.entries.length, digest: stateDigest(room.state), json: JSON.stringify(room.state), pointers: pointers(room.state) };
  const answer = submit(room, sender, msg);
  expect(answer.kind).toBe("refused");
  expect((answer as { reason?: string }).reason).toBe(sentence);
  expect(room.entries).toHaveLength(before.log);
  expect(stateDigest(room.state)).toBe(before.digest);
  expect(JSON.stringify(room.state)).toBe(before.json);
  expect(pointers(room.state)).toEqual(before.pointers);
}

/* ================================================================================================== */
describe.each(GAMES)("RR2A-F1 (%s): BeginOperatingRound cannot leave an open auction", (_name, make) => {
  it("1. (F) the seat the auction is waiting on is refused -- the auction, the round and the turn stay where they were", () => {
    const room = make();
    expect(room.state.waterfall?.privates.length).toBeGreaterThan(0);
    expectRefusedEverywhere(room, actorOf(room.state), BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
    // And the auction is still live: its next legal move applies for the player it was waiting on.
    const buyer = actorOf(room.state);
    applied(room, buyer, BUY);
    expect(room.state.current_round_type).toBe("WaterfallAuction");
  });

  it("2. (F) every other seat hears the same reason -- never 'It is not your turn.', which would say that on your turn you could", () => {
    const room = make();
    for (const seat of room.state.player_addresses) {
      expectRefusedEverywhere(room, seat, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
    }
  });

  it("3. (F) nor through a live contest: the contest's current bidder is refused, and the contest is untouched", () => {
    const room = make();
    // Two bids on one private, then the cheapest is bought: the cascade opens a contest on it.
    const privates = room.state.waterfall!.privates.map((p) => p.private_id);
    const target = privates[1];
    const face = Number(room.state.waterfall!.privates[1].face_value);
    for (let guard = 0; room.state.waterfall?.mini_auction == null; guard += 1) {
      if (guard > 6) throw new Error("no contest opened");
      const who = actorOf(room.state);
      const bids = room.state.waterfall!.privates.find((p) => p.private_id === target)!.bids;
      if (bids.length < 2 && !bids.some((bid) => bid.bidder === who)) applied(room, who, BID(target, face + 5 * (bids.length + 1)));
      else applied(room, who, BUY);
    }
    const contest = room.state.waterfall!.mini_auction!;
    expect(actorOf(room.state)).toBe(contest.current_turn);
    expectRefusedEverywhere(room, contest.current_turn, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
    // The contest goes on with a legal raise.
    const high = Math.max(...room.state.waterfall!.privates.find((p) => p.private_id === target)!.bids.map((bid) => Number(bid.bid_amount)));
    applied(room, contest.current_turn, MINI_RAISE(high + 5));
  });

  it("4. (F) a PassTurn from the auction's actor -- a stale End Turn -- is refused and never becomes the table's last action", () => {
    const room = make();
    const last = room.entries[room.entries.length - 1]?.id ?? null;
    expectRefusedEverywhere(room, actorOf(room.state), PASS_TURN, RT.TURN_PASS_IN_AUCTION_REFUSAL);
    expect(room.entries[room.entries.length - 1]?.id ?? null).toBe(last);
    // The auction's own pass is the one that applies.
    applied(room, actorOf(room.state), { WaterfallPass: { game_id: 0 } });
  });

  it("5. a spectator is refused by the transport before any rule is asked", () => {
    const room = make();
    const before = { log: room.entries.length, digest: stateDigest(room.state) };
    const answer = submit(room, "p-rr2a-watcher", BEGIN_OR, { seated: false });
    expect(answer).toMatchObject({ kind: "refused", code: "not-seated" });
    expect(room.entries).toHaveLength(before.log);
    expect(stateDigest(room.state)).toBe(before.digest);
  });
});

/* ================================================================================================== */
describe("RR2A-F1: the auction's end, the race with the handoff, and the rounds after it", () => {
  /** Buys the whole auction out at face value, each purchase by whoever it is waiting on. */
  function buyOut(room: Room) {
    for (let guard = 0; (room.state.waterfall?.privates.length ?? 0) > 0; guard += 1) {
      if (guard > 12) throw new Error("the auction did not advance");
      applied(room, actorOf(room.state), BUY);
    }
  }

  it("6. (F) after the last private sells and before the handoff, a racing BeginOperatingRound is refused -- the B&O par and the handoff still apply", () => {
    for (const make of [standardRoom, delayedRoom]) {
      const room = make();
      buyOut(room);
      expect(room.state.current_round_type).toBe("WaterfallAuction");
      const owner = ownerOf(room.state, BO) as string;
      for (const seat of room.state.player_addresses) {
        expectRefusedEverywhere(room, seat, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
      }
      applied(room, owner, PAR(owner));
      expectRefusedEverywhere(room, owner, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
      applied(room, owner, OPEN);
      expect(room.state.current_round_type).toBe("StockRound");
      expect(room.state.private_auction_complete).toBe(true);
    }
  });

  it("7. (F) the Stock Round cannot be cut short either -- the Delayed Auction's Stock Round 1 included", () => {
    const standard = standardRoom();
    buyOut(standard);
    const owner = ownerOf(standard.state, BO) as string;
    applied(standard, owner, PAR(owner));
    applied(standard, owner, OPEN);
    expectRefusedEverywhere(standard, seatOf(standard.state), BEGIN_OR, RT.OPERATING_ROUND_FROM_STOCK_ROUND_REFUSAL);

    const delayed = roomFrom();
    applied(delayed, A, SETUP(true));
    expect(delayed.state.current_round_type).toBe("StockRound");
    expect(delayed.state.macro_round_number).toBe(1);
    for (const seat of delayed.state.player_addresses) {
      expectRefusedEverywhere(delayed, seat, BEGIN_OR, RT.OPERATING_ROUND_FROM_STOCK_ROUND_REFUSAL);
    }
  });

  it("8. an unpinned (legacy) board keeps the arm it was played on (D-9) -- the corpus holds no BeginOperatingRound at all", () => {
    const engine = new RL.RoomEngine(sandboxReplayProviders(), seed() as never);
    engine.apply(entry(A, SETUP(false)));
    const legacy = boardOf(engine);
    expect(legacy.rules_engine_version).toBeUndefined();
    expect(RT.roundTransitionRefusal(legacy, BEGIN_OR as never)).toBeNull();
    expect(turnRefusal({ state: legacy, waterfall: legacy.waterfall ?? null, actor: actorOf(legacy), msg: BEGIN_OR as never })).toBeNull();
  });
});

/* ================================================================================================== */
describe("RR2A-F1 positive control: the Stock Round's closing passes still open the Operating Round", () => {
  /** One Stock Round turn under Sell-Buy-Sell (#1443): Pass (Sell -> Buy), the purchase, Pass (ends the turn). */
  function buyTurn(room: Room, player: string, companyId: number, par?: string) {
    expect(seatOf(room.state)).toBe(player);
    applied(room, player, PASS_TURN);
    applied(room, player, { BuyStock: { game_id: 0, protocol_id: companyId, source: "Ipo", ...(par ? { par_value: par } : {}) } });
    applied(room, player, PASS_TURN);
  }
  /** A turn with nothing done: Pass (Sell -> Buy), Pass (a pass in the streak). */
  function passTurn(room: Room) {
    const seat = seatOf(room.state);
    applied(room, seat, PASS_TURN);
    if (seatOf(room.state) === seat && room.state.current_round_type === "StockRound") applied(room, seat, PASS_TURN);
  }
  /** Floats `ticker` for `president` (buying the President's Certificate first when `par` is given), then lets the
   *  table pass the round out. Returns the board the last pass produced. */
  function floatAndPassOut(room: Room, president: string, ticker: string, buys: number, par?: string) {
    const company = room.state.public_companies.find((c) => c.ticker === ticker)!;
    let bought = 0;
    for (let guard = 0; bought < buys; guard += 1) {
      if (guard > 30) throw new Error(`${ticker} did not reach 60%`);
      if (seatOf(room.state) === president) {
        buyTurn(room, president, company.company_id, bought === 0 ? par : undefined);
        bought += 1;
      } else passTurn(room);
    }
    const macro = room.state.macro_round_number;
    for (let guard = 0; room.state.current_round_type === "StockRound" && room.state.macro_round_number === macro; guard += 1) {
      if (guard > 8) throw new Error("the Stock Round did not end");
      passTurn(room);
    }
    return room.state;
  }

  it("9. standard: the auction, the par, the handoff, a float, the passes -- and the Operating Round opens with no request", () => {
    const room = standardRoom();
    for (let guard = 0; (room.state.waterfall?.privates.length ?? 0) > 0; guard += 1) {
      if (guard > 12) throw new Error("the auction did not advance");
      applied(room, actorOf(room.state), BUY);
    }
    const owner = ownerOf(room.state, BO) as string;
    applied(room, owner, PAR(owner));
    applied(room, owner, OPEN);
    const bo = room.state.public_companies.find((c) => c.ticker === "B&O")!;
    const board = floatAndPassOut(room, owner, "B&O", 4);
    expect(board.current_round_type).toBe("OperatingRound");
    expect(board.active_operating_order).toEqual([bo.company_id]);
    expect(JSON.stringify(room.entries)).not.toContain("BeginOperatingRound");
  });

  it("10. Delayed Auction: Stock Round 1, a float, the passes -- the Operating Round opens with no request, and (F) refuses one inside it", () => {
    const room = roomFrom();
    applied(room, A, SETUP(true));
    const prr = room.state.public_companies.find((c) => c.ticker === "PRR")!;
    const board = floatAndPassOut(room, A, "PRR", 5, "100");
    expect(board.current_round_type).toBe("OperatingRound");
    expect(board.active_operating_order).toEqual([prr.company_id]);
    expect(board.waterfall?.waterfall_auction_active).toBe(false); // still dealt dormant: no 3-train yet
    expect(JSON.stringify(room.entries)).not.toContain("BeginOperatingRound");
    // At the turn's opening the home-station hold answers first (the holds outrank every other question, #1613)...
    expect(turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor: A, msg: BEGIN_OR as never })).toContain("home station");
    expect(applySandboxAction(board, BEGIN_OR as never, { actor: A } as never)).toBe(board);
    // ...and once the station is down, the round's own sentence: it moves on by itself.
    const h12 = STATIC_BOARD_HEXES.find((hex) => hex.label === "H12")!;
    applied(room, A, { PlaceHomeStation: { game_id: 0, company_id: prr.company_id, q: h12.q, r: h12.r, kind: "home", city_index: null, hex_label: "H12" } });
    expect(room.state.current_round_type).toBe("OperatingRound");
    expectRefusedEverywhere(room, A, BEGIN_OR, RT.OPERATING_ROUND_ALREADY_RUNNING_REFUSAL);
  });
});
