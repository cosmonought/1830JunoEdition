/** @jest-environment node */
//
// ==================================================================
//  DA-7: DELAYED AUCTION CERTIFICATION -- THE REAL RUN (G-DA) AND ITS TAILS
// ==================================================================
//
// `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` §21 designed the certification game; DA-3 ... DA-6 certified each
// rule on boards hand-built at the trigger set. This file plays the Delayed Auction FROM THE DEAL, every message through
// a pinned `RoomSession` (the server's own path: ingress, the server's draw, the append, the room's derived entries),
// with no board patched between steps:
//
//   Deal -> Stock Round 1 -> Operating Round 1 -> Stock Round 2 -> Operating Round 2 (the first 3-train, bought by the
//   EARLIER corporation, so the set continues) -> the delayed private company auction (Priority Deal opener, a contest,
//   a pass, the C&A grant changing the PRR's presidency, the B&O won at face) -> the B&O par -> Stock Round 3 -> the
//   Operating Round set that follows (a corporation buys a private from its president; the B&O's first train closes
//   the BO private) -> Stock Round 4, with nothing of the auction left.
//
// At every boundary (G-DA A-G) both the legal move and the illegal ones are asserted, and every assertion is made at
// THREE layers that must agree: ingress (`turnRefusal`), the reducer (a room engine on the same board, compared by
// digest) and the room (`RoomSession.submit`: refused, nothing appended, digest unchanged). After every applied message
// every corporation's certificates add to 100% and the money in the game is constant.
//
// The tails: T3 (the C&A with the PRR's ordinary IPO exhausted), T4 (an auction purchase that creates a curable
// overage -- the must-sell hold, cured, no permanent hold), T5 / D-55 (the first 5-train before the auction cancels it,
// through the room, and no later set re-arms it) and the standard-game control (the same flow with the auction first:
// nothing delayed leaks in). Restore / replay / one-step `RevertTo` are certified at the cut points of §8 of the DA-7
// brief. Every game here is dealt at the CURRENT engine (`RULES_ENGINE_VERSION`: 10 when DA-7 certified it, 11 since DA-8's
// closure, which carries DA-7's semantics unchanged); nothing here is a golden or a corpus entry.

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Room = InstanceType<typeof import("./roomSession").RoomSession>;
type ServerLogEntry = import("./roomSession").ServerLogEntry;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { actingAddress, certificateBreakdown } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { RULES_ENGINE_VERSION, SERVER_REPLAY_POLICY } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { derivePhase } = require("../gameEngine/gamePhase") as typeof import("../gameEngine/gamePhase");
const { effectiveActions, REVERT_ONE_STEP } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");
const RT = require("../gameEngine/roundTransitionAuthority") as typeof import("../gameEngine/roundTransitionAuthority");
const { boIsLocked, resolveVariants, BO_LOCKED_REASON } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { ordinaryPercentAvailable } =
  require("../gameEngine/stockTransactionAuthority") as typeof import("../gameEngine/stockTransactionAuthority");
const { reservedIpoRefusal } = require("../gameEngine/sharePurchase") as typeof import("../gameEngine/sharePurchase");
const { privatesBuyableNow } = require("../gameEngine/operatingSubPhase") as typeof import("../gameEngine/operatingSubPhase");
const { boParOwedTo, auctionHandoffRefusal } = require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");
const { chartForDivestment, divestmentDebt, divestmentPassRefusal } =
  require("../gameEngine/forcedDivestment") as typeof import("../gameEngine/forcedDivestment");
const { operatingRoundSequenceLength } = require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { harmlessDuplicateAnswer, HARMLESS_DUPLICATE_ANSWER_SENTENCE } =
  require("../gameEngine/harmlessDuplicate") as typeof import("../gameEngine/harmlessDuplicate");
const { validateGameplayMessage } = require("../gameEngine/messageSchema") as typeof import("../gameEngine/messageSchema");
const { describeGameplayAction } = require("./actionLog") as typeof import("./actionLog");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");
const { STATION_HOME_HEXES } = require("../components/hexContractTypes") as typeof import("../components/hexContractTypes");
const { readStripped, readShell } = require("./sourceScan") as typeof import("./sourceScan");
const YS = require("./yellowSignRunBoundSupport") as typeof import("./yellowSignRunBoundSupport");
const { STATIC_BOARD_HEXES } = require("../components/hexBoardData") as typeof import("../components/hexBoardData");
const { marketCellForPrice } = require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { bankIsBroken } = require("../gameEngine/endgame") as typeof import("../gameEngine/endgame");
const { appraiseSeats } = require("../gameEngine/settlementAppraisal") as typeof import("../gameEngine/settlementAppraisal");
const { REVERT_GAME_ENDED } = require("../gameEngine/logRevert") as typeof import("../gameEngine/logRevert");

const A = "p-da7-a01";
const B = "p-da7-b02";
const C = "p-da7-c03";
const SPECTATOR = "p-da7-z99";
const BUILD = "b-da7";
const SV = 1;
const CS = 2;
const DH = 3;
const MH = 4;
const CA = 5;
const BO = 6;

const SETUP = (delayed: boolean, extra: Record<string, unknown> = {}) => ({
  SetupGame: {
    players: [
      { id: A, nickname: "A" },
      { id: B, nickname: "B" },
      { id: C, nickname: "C" },
    ],
    variants: { delayedAuction: delayed, length: "standard", rules: 1, ...extra },
  },
});
const PASS_TURN = { PassTurn: { game_id: 0 } };
const BEGIN_OR = { BeginOperatingRound: { game_id: 0 } };
const OPEN = { OpenStockRound: {} };
const PAR = (player: string, par: number) => ({ SetBoPar: { player, par_value: String(par) } });
const WF_BUY = { WaterfallBuyLowest: { game_id: 0 } };
const WF_PASS = { WaterfallPass: { game_id: 0 } };
const WF_BID = (privateId: number, amount: number) => ({
  WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) },
});
const WF_RAISE = (amount: number) => ({ WaterfallMiniAuctionRaise: { game_id: 0, bid_amount: String(amount) } });
const WF_MINI_PASS = { WaterfallMiniAuctionPass: { game_id: 0 } };

const companyOf = (board: State, ticker: string) => board.public_companies.find((company) => company.ticker === ticker)!;
const heldBy = (board: State, ticker: string, player: string) =>
  companyOf(board, ticker).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const BUY_STOCK = (board: State, ticker: string, par?: number) => ({
  BuyStock: { game_id: 0, protocol_id: companyOf(board, ticker).company_id, source: "Ipo", ...(par === undefined ? {} : { par_value: String(par) }) },
});
const SELL = (board: State, ticker: string, percentage: number) => ({
  SellStock: { game_id: 0, protocol_id: companyOf(board, ticker).company_id, percentage },
});
const TRAIN = (board: State, ticker: string) => ({ BuyHardwareFromPool: { game_id: 0, protocol_id: companyOf(board, ticker).company_id } });
const ADVANCE = (board: State, ticker: string) => ({ AdvanceOperatingSubPhase: { game_id: 0, protocol_id: companyOf(board, ticker).company_id } });
const BUY_PRIVATE = (board: State, ticker: string, privateId: number, price: number) => ({
  BuyPrivateCompany: { game_id: 0, protocol_id: companyOf(board, ticker).company_id, private_id: privateId, price: String(price) },
});
const REVERT = (index: number, player: string) => ({ RevertTo: { index, player, summary: "undo" } });

const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const holderOf = (board: State) => board.player_addresses[board.priority_deal_index];
const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const ownerOf = (board: State, id: number) => board.private_companies.find((entry) => entry.private_id === id)?.owner ?? null;
const privateOf = (board: State, id: number) => board.private_companies.find((entry) => entry.private_id === id)!;
const operating = (board: State) =>
  board.current_round_type === "OperatingRound"
    ? board.public_companies.find((company) => company.company_id === board.active_operating_order[board.active_corporation_index]) ?? null
    : null;
const tier = (board: State) => derivePhase(board)?.tier ?? null;
const lockedBo = (board: State) => boIsLocked(resolveVariants(board.variants), board.private_auction_complete);
const pdPending = (board: State) => resolveVariants(board.variants).delayedAuction === true && board.private_auction_complete === false;
const buyablePrivates = (board: State) => privatesBuyableNow(null, board.private_companies, tier(board));
const kindOf = (entry: { payload: string; derived?: boolean }) => `${Object.keys(JSON.parse(entry.payload))[0]}${entry.derived ? "*" : ""}`;
/** The money in the game: the bank, the players, the treasuries. (A standing auction bid is a claim on its bidder's
 *  cash, not a transfer -- the cash moves when the private is awarded -- so it is not added a second time.) */
const money = (board: State) =>
  Number(board.virtual_bank_vgp) +
  board.player_cash.reduce((sum, entry) => sum + Number(entry.cash_vgp), 0) +
  board.public_companies.reduce((sum, company) => sum + Number(company.treasury ?? 0), 0);
const cashOf = (board: State, player: string) => Number(board.player_cash.find((entry) => entry.player === player)?.cash_vgp ?? NaN);
const countOf = (board: State, player: string) => {
  const chart = chartForDivestment(board);
  return certificateBreakdown(player, board, chart.marketPrices, chart.zoneForPrice as never).counted;
};

/* ---- the room ---------------------------------------------------------------------------------------------------- */

const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});
let rooms = 0;
function newRoom(start?: { state: State; waterfall: State["waterfall"] | null }, providers?: object): Room {
  let n = 0;
  const tag = (rooms += 1);
  return new RoomSession({
    providers: (providers ?? sandboxReplayProviders()) as never,
    seed: (start ?? seed()) as never,
    build: BUILD,
    mintId: () => `da7-${tag}-${(n += 1)}`,
    now: () => 0,
    mintSeed: () => 1,
  });
}
const submitRaw = (room: Room, actor: string, msg: unknown, extra: Record<string, unknown> = {}) =>
  room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A, seated: true, ...extra } as never) as {
    kind: string;
    reason?: string;
    code?: string;
    entries?: ServerLogEntry[];
  };
const ingressOf = (room: Room, actor: string, msg: unknown) =>
  turnRefusal({ state: room.state, waterfall: room.state.waterfall ?? null, actor, msg: msg as never, host: A, log: room.entries });

/** THE CERTIFICATE CONTROL: holdings + IPO + Bank Pool = 100% for every corporation, and a reserved certificate is one
 *  the IPO actually holds. */
function expectConserved(board: State, where: string) {
  for (const company of board.public_companies) {
    const held = company.player_holdings.reduce((sum, holding) => sum + holding.percentage, 0);
    expect([where, company.ticker, held + company.ipo_pool_percentage + company.bank_pool_percentage]).toEqual([where, company.ticker, 100]);
    expect([where, company.ticker, (company.reserved_certificate?.percentage ?? 0) <= company.ipo_pool_percentage]).toEqual([where, company.ticker, true]);
  }
}

type Start = { state: State; waterfall: State["waterfall"] | null };

/** The reducer's own answer on the room's board: a REPLICA of the room's engine (the same seed and providers, the
 *  room's effective log replayed), handed the message directly -- no ingress, no transport -- compared by digest. */
function reducerMoves(game: Game, actor: string, msg: unknown): boolean {
  const engine: Engine = new RL.RoomEngine(game.providers as never, game.start as never);
  for (const entry of effectiveActions(game.room.entries)) engine.apply(entry);
  const before = stateDigest(engine.snapshot.state);
  expect(before).toBe(stateDigest(game.state)); // the replica IS the room's board
  engine.apply(RL.entriesFromExport([{ index: game.room.nextIndex, id: "reducer-probe", actor, at: 0, msg: msg as never }])[0]);
  return stateDigest(engine.snapshot.state) !== before;
}

/** A game played through one room: the room, the money it started with, and the boards at named cut points. */
interface Mark {
  entries: ServerLogEntry[];
  state: State;
  digest: string;
}
class Game {
  readonly room: Room;
  readonly start: Start;
  readonly providers: object;
  readonly marks = new Map<string, Mark>();
  bank = 0;
  constructor(room: Room, start: Start = seed() as Start, providers: object = sandboxReplayProviders()) {
    this.room = room;
    this.start = start;
    this.providers = providers;
  }
  get state(): State {
    return this.room.state;
  }
  mark(label: string): Mark {
    const mark = {
      entries: (this.room.entries as ServerLogEntry[]).map((entry) => ({ ...entry })),
      state: JSON.parse(JSON.stringify(this.room.state)) as State,
      digest: stateDigest(this.room.state),
    };
    this.marks.set(label, mark);
    return mark;
  }
  at(label: string): Mark {
    const mark = this.marks.get(label);
    if (!mark) throw new Error(`no mark ${label}`);
    return mark;
  }
  /** LEGAL, at every layer: ingress admits it, the room applies it, certificates and money are conserved. */
  play(actor: string, msg: unknown): string[] {
    const kind = Object.keys(msg as object)[0];
    expect([kind, actor, ingressOf(this.room, actor, msg)]).toEqual([kind, actor, null]);
    const answer = submitRaw(this.room, actor, msg);
    if (answer.kind !== "applied") throw new Error(`${kind} by ${actor} was ${answer.kind}: ${answer.reason}`);
    expectConserved(this.state, kind);
    if (this.bank !== 0) expect([kind, money(this.state)]).toEqual([kind, this.bank]);
    return (answer.entries ?? []).map(kindOf);
  }
  /** REFUSED, at every layer: the ingress sentence (or, where ingress does not mirror the rule, the room's), the reducer
   *  moves nothing, the room appends nothing and moves no digest. Returns the sentence. */
  refuse(actor: string, msg: unknown, sentence?: string | RegExp): string {
    const kind = Object.keys(msg as object)[0];
    const board = this.state;
    const ingress = ingressOf(this.room, actor, msg);
    const before = { entries: this.room.entries.length, digest: stateDigest(board) };
    const answer = submitRaw(this.room, actor, msg);
    expect([kind, actor, answer.kind]).toEqual([kind, actor, "refused"]);
    expect([kind, this.room.entries.length, stateDigest(this.state)]).toEqual([kind, before.entries, before.digest]);
    if (ingress !== null) expect([kind, answer.reason]).toEqual([kind, ingress]);
    /* The reducer on the same board agrees -- it moves nothing either (a refusal at both locks) -- for every RULE.
       WHO MAY SEND IT is the one question the reducer does not ask, by design (#1174: it cannot read "was this
       player on turn" without the cursor #549 forbids it; #1207: the actor comes from the connection, never the
       frame). A log replays what was committed, so that question is the transport's and ingress's -- the
       "legitimately stronger outer hold" of the DA-7 brief §9. Such a refusal must carry one of the seat sentences,
       and is recorded; a RULE the reducer does not also enforce would fail here. */
    /* A `RevertTo` is an instruction about the LOG (#1026): the room resolves it by rebuilding, never through the
       reducer, so the reducer is not asked (`UNCHANGED_IS_NOT_A_REFUSAL`); its authority is `revertRefusal` alone. */
    if (!("RevertTo" in (msg as object)) && reducerMoves(this, actor, msg)) {
      expect([kind, actor, ingress !== null && SEAT_SENTENCES.some((pattern) => pattern.test(ingress ?? ""))]).toEqual([kind, actor, true]);
      seatOnly.push(`${kind} by ${actor.slice(-3)}: ${ingress}`);
    }
    const reason = answer.reason ?? "";
    if (typeof sentence === "string") expect([kind, reason]).toEqual([kind, sentence]);
    else if (sentence instanceof RegExp) expect(reason).toMatch(sentence);
    return reason;
  }
}

function dealt(delayed: boolean, extra: Record<string, unknown> = {}): Game {
  const game = new Game(newRoom());
  game.play(A, SETUP(delayed, extra));
  expect(game.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
  game.bank = money(game.state);
  return game;
}

/* ---- the turns --------------------------------------------------------------------------------------------------- */

/** One Stock Round turn under Sell-Buy-Sell (#1443): Pass (Sell -> Buy), the purchase, Pass (ends the turn). */
function buyTurn(game: Game, ticker: string, par?: number): string {
  const player = seatOf(game.state);
  game.play(player, PASS_TURN);
  game.play(player, BUY_STOCK(game.state, ticker, par));
  game.play(player, PASS_TURN);
  return player;
}
/** A turn with nothing done: Pass (Sell -> Buy), Pass (a pass in the streak). */
function passTurn(game: Game): string {
  const player = seatOf(game.state);
  const macro = game.state.macro_round_number;
  game.play(player, PASS_TURN);
  if (game.state.current_round_type === "StockRound" && game.state.macro_round_number === macro && seatOf(game.state) === player) {
    game.play(player, PASS_TURN);
  }
  return player;
}
/** A turn that sells first, then ends. */
function sellTurn(game: Game, ticker: string, percentage: number): string {
  const player = seatOf(game.state);
  game.play(player, SELL(game.state, ticker, percentage));
  game.play(player, PASS_TURN);
  game.play(player, PASS_TURN);
  return player;
}
/** Whether the game stands in an Operating Round (a function, so a loop's condition is re-read, not narrowed). */
const inOperating = (game: Game): boolean => game.state.current_round_type === "OperatingRound";
/** The Operating Round step the game stands on (a function, for the same reason). */
const stepOf = (game: Game): string | null => game.state.operating_sub_phase ?? null;
function finishStockRound(game: Game): State {
  const macro = game.state.macro_round_number;
  for (let guard = 0; game.state.current_round_type === "StockRound" && game.state.macro_round_number === macro; guard += 1) {
    if (guard > 12) throw new Error("the Stock Round did not end");
    passTurn(game);
  }
  return game.state;
}
const home = (companyId: number) => STATION_HOME_HEXES.find((entry) => entry.companyId === companyId)!;

/** One corporation's Operating Round turn, driven by its president: the home station when owed, then `before` (once,
 *  at the turn's first step -- a private purchase is a standing button, #1440), the steps skipped to Hardware when it
 *  has trains to buy, `buys` depot purchases, then End Turn if the room has not ended it. */
function orTurn(game: Game, buys = 0, before?: (game: Game) => void): string {
  const start = operating(game.state)!;
  const { macro_round_number: macro, sub_round_index: sub } = game.state;
  const same = () => {
    const now = operating(game.state);
    return now?.company_id === start.company_id && game.state.macro_round_number === macro && game.state.sub_round_index === sub;
  };
  let bought = 0;
  let asked = false;
  for (let guard = 0; same(); guard += 1) {
    if (guard > 16) throw new Error(`${start.ticker}'s turn did not end`);
    const board = game.state;
    const company = operating(board)!;
    const president = company.president!;
    if ((company.station_token_hexes ?? []).length === 0) {
      const hex = home(company.company_id);
      game.play(president, { PlaceHomeStation: { game_id: 0, company_id: company.company_id, q: hex.q, r: hex.r, kind: "home", city_index: null, hex_label: hex.label } });
      continue;
    }
    if (!asked && before) {
      asked = true;
      before(game);
      continue;
    }
    const wants = bought < buys;
    if (board.operating_sub_phase === "Hardware" && wants) {
      bought += 1;
      game.play(president, TRAIN(board, company.ticker));
      continue;
    }
    if (board.operating_sub_phase !== "Hardware" && wants) {
      game.play(president, ADVANCE(board, company.ticker));
      continue;
    }
    game.play(president, PASS_TURN);
  }
  expect([start.ticker, bought]).toEqual([start.ticker, buys]);
  return start.ticker;
}

type AuctionStep = "buy" | "pass" | "mini-pass" | ["bid", number, number] | ["raise", number];
function auctionStep(game: Game, step: AuctionStep, expectedActor?: string): string {
  const actor = actorOf(game.state);
  if (expectedActor !== undefined) expect(actor).toBe(expectedActor);
  const msg =
    step === "buy" ? WF_BUY : step === "pass" ? WF_PASS : step === "mini-pass" ? WF_MINI_PASS : step[0] === "bid" ? WF_BID(step[1], step[2]) : WF_RAISE(step[1]);
  game.play(actor, msg);
  return actor;
}

/* ---- restore / replay at a cut point ------------------------------------------------------------------------------- */

const replayOf = (entries: readonly ServerLogEntry[], start: object = seed(), providers: object = sandboxReplayProviders()) =>
  RL.replayLog(entries as never, providers as never, start as never, undefined, SERVER_REPLAY_POLICY);
function restoredAt(mark: Mark, start?: { state: State; waterfall: State["waterfall"] | null }, providers?: object): Room {
  const room = newRoom(start, providers);
  room.restore(JSON.parse(JSON.stringify(mark.entries)) as ServerLogEntry[]);
  return room;
}
/** The authority-relevant fields, named (the digest covers the whole board; these say WHERE if it ever differs). */
const authority = (board: State) => ({
  round: board.current_round_type,
  macro: board.macro_round_number,
  sub: board.sub_round_index,
  seat: board.active_player_index,
  priorityDeal: board.priority_deal_index,
  complete: board.private_auction_complete ?? null,
  auction: board.waterfall ?? null,
  privates: board.private_companies,
  phase: tier(board),
  companies: board.public_companies.map((company) => ({
    ticker: company.ticker,
    president: company.president,
    holdings: company.player_holdings,
    ipo: company.ipo_pool_percentage,
    pool: company.bank_pool_percentage,
    reserved: company.reserved_certificate ?? null,
    par: company.par_value ?? null,
    trains: company.owned_trains,
    treasury: company.treasury,
    floated: company.is_floated,
  })),
  cash: board.player_cash,
  stage: board.stock_turn_stage ?? null,
  cursor: [board.active_operating_order, board.active_corporation_index, board.operating_sub_phase ?? null],
});
/** live == fresh replay == serialized restore, by digest and by the named authority fields; twice for the restore. */
function expectRebuildsAt(mark: Mark, label: string, start?: { state: State; waterfall: State["waterfall"] | null }, providers?: object) {
  const replay = replayOf(mark.entries, (start ?? seed()) as Start, providers);
  const restored = [restoredAt(mark, start, providers), restoredAt(mark, start, providers)];
  expect([label, stateDigest(replay.state)]).toEqual([label, mark.digest]);
  expect([label, authority(replay.state)]).toEqual([label, authority(mark.state)]);
  for (const room of restored) {
    expect([label, stateDigest(room.state)]).toEqual([label, mark.digest]);
    expect([label, authority(room.state)]).toEqual([label, authority(mark.state)]);
  }
  return restored[0];
}

/* ==================================================================================================================== */
/* THE MAIN PATH -- G-DA, played once                                                                                   */
/* ==================================================================================================================== */

interface Probe {
  label: string;
  reason: string;
}
const probes: Probe[] = [];
const probe = (label: string, reason: string) => probes.push({ label, reason });
const NO_AUCTION = /no private company auction running/;
/** The sentences of the sender questions -- turn, ownership of the named seat, the one-step undo -- that ingress and the
 *  transport own and the reducer, replaying committed history, does not re-ask (see `Game.refuse`). */
const SEAT_SENTENCES: readonly RegExp[] = [
  /^It is not your turn\.$/,
  /^Only the B&O private's owner pars the B&O\.$/,
  /^Only the most recent action can be undone\.$/,
  /^Other players have acted since your last move\./,
];
const seatOnly: string[] = [];
/** DA7-L1 (LOW, recorded): outside the auction, the seat the round is waiting on hears the auction's sentence, and every
 *  other seat hears "It is not your turn." -- the seat question runs before DA-3's round gate at ingress. Refused at
 *  every layer either way; only the off-turn wording implies a turn would help. */
const noAuction = (game: Game, player: string): RegExp =>
  player === actingAddress(game.state, game.state.waterfall ?? null) ? NO_AUCTION : /^It is not your turn\.$/;

function playGda(): Game {
  const game = dealt(true);
  game.mark("A.deal");

  /* ---- Stock Round 1 (A holds the Priority Deal): PRR and NYC started and floated ---- */
  buyTurn(game, "PRR", 100); // A 20
  buyTurn(game, "NYC", 90); // B 20
  buyTurn(game, "PRR"); // C 10
  game.mark("A.sr1-mid");
  buyTurn(game, "PRR"); // A 30
  buyTurn(game, "NYC"); // B 30
  buyTurn(game, "NYC"); // C 10
  buyTurn(game, "PRR"); // A 40
  buyTurn(game, "NYC"); // B 40
  buyTurn(game, "PRR"); // C 20 -- the PRR floats at 60%
  game.mark("A.sr1-sale-probe");
  buyTurn(game, "NYC"); // A 10 -- the NYC floats at 60%
  finishStockRound(game);
  game.mark("B.or1-open");

  /* ---- Operating Round 1 (phase 2, a one-round set): three 2-trains each ---- */
  orTurn(game, 3); // PRR
  game.mark("B.or1-nyc");
  orTurn(game, 3); // NYC -- the six 2-trains are gone
  game.mark("B.sr2-open");

  /* ---- Stock Round 2 (B holds the Priority Deal): A sells 20% of the PRR -- sales are legal after Stock Round 1 ---- */
  passTurn(game); // B
  passTurn(game); // C
  sellTurn(game, "PRR", 20); // A: 40 -> 20, level with C
  finishStockRound(game);
  game.mark("B.or2-open");

  /* ---- Operating Round 2: the NYC (now first -- the PRR's price fell) buys the FIRST 3-train; the set continues ---- */
  orTurn(game, 1); // NYC: 2,2,2 + 3 fills its fleet and the room ends its turn
  game.mark("C.trigger");
  // The PRR's turn opens; it walks to Hardware (its fleet has room)...
  const prrPresident = companyOf(game.state, "PRR").president!;
  for (let guard = 0; game.state.operating_sub_phase !== "Hardware"; guard += 1) {
    if (guard > 6) throw new Error("the PRR did not reach Hardware");
    game.play(prrPresident, ADVANCE(game.state, "PRR"));
  }
  game.mark("C.prr-hardware");
  // ...its 3-train fills the fleet, the room ends the turn, the set ends, and the auction is armed.
  game.play(prrPresident, TRAIN(game.state, "PRR"));
  game.mark("D.auction-open");

  /* ---- The delayed private company auction ---- */
  auctionStep(game, "buy", B); // B buys the SV at face
  game.mark("D.after-first-buy");
  auctionStep(game, ["bid", DH, 75], C);
  auctionStep(game, ["bid", DH, 80], A);
  game.mark("D.mid-auction"); // two bids escrowed on the D&H
  auctionStep(game, "buy", B); // B buys the C&SL; the D&H, lowest now, has two bids: a contest
  game.mark("D.contest");
  auctionStep(game, ["raise", 85], C);
  auctionStep(game, "mini-pass", A); // C wins the D&H at $85
  auctionStep(game, "pass", C); // C passes on the M&H
  auctionStep(game, "buy", A); // A buys the M&H
  auctionStep(game, "pass", B); // B passes on the C&A
  game.mark("E.before-ca");
  auctionStep(game, "buy", C); // C buys the C&A: the reserved PRR 10% -- C 30 over A 20
  game.mark("E.ca-granted");
  auctionStep(game, "buy", A); // A buys the BO at face: the last private
  game.mark("E.last-private");
  game.play(A, PAR(A, 67));
  game.mark("E.par-set");
  game.play(A, OPEN);
  game.mark("F.sr-open");

  /* ---- Stock Round 3: the B&O trades; the C&A's PRR share is C's to sell ---- */
  buyTurn(game, "B&O"); // B 10 (the Priority Deal holder opens)
  sellTurn(game, "PRR", 10); // C sells the certificate the C&A brought
  game.mark("F.after-ca-sale");
  buyTurn(game, "B&O"); // A 30
  buyTurn(game, "B&O"); // B 20
  buyTurn(game, "B&O"); // C 10 -- the B&O floats at 60%
  finishStockRound(game);
  game.mark("G.or3-open");
  return game;
}

let G: Game;
beforeAll(() => {
  G = playGda();
});

describe("G-DA A: the deal and Stock Round 1", () => {
  it("the auction is not active, every private is unsold and unowned, the C&A's PRR share is reserved, the B&O is locked", () => {
    const board = G.at("A.deal").state;
    expect([board.current_round_type, board.macro_round_number]).toEqual(["StockRound", 1]);
    expect(board.private_auction_complete).toBe(false);
    expect(board.waterfall?.waterfall_auction_active).toBe(false);
    expect(board.private_companies.map((entry) => [entry.private_id, entry.owner ?? null, entry.owner_protocol_id ?? null, !!entry.closed])).toEqual(
      [SV, CS, DH, MH, CA, BO].map((id) => [id, null, null, false]),
    );
    expect(companyOf(board, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(ordinaryPercentAvailable(companyOf(board, "PRR"), "Ipo")).toBe(70);
    expect(lockedBo(board)).toBe(true);
    // What the shell reads (DA-6): the pending auction, no Buy Private Company, the Priority Deal holder seated.
    expect(pdPending(board)).toBe(true);
    expect(buyablePrivates(board)).toBe(false);
    expect([seatOf(board), holderOf(board)]).toEqual([A, A]);
  });

  it("refuses, at ingress, the reducer and the room: the B&O (par and purchase), SetBoPar, every auction message, an SR1 sale, BeginOperatingRound", () => {
    const room = restoredAt(G.at("A.sr1-mid"));
    const game = new Game(room);
    const board = room.state;
    const seat = seatOf(board);
    expect(seat).toBe(A);
    game.refuse(seat, SELL(board, "PRR", 10), "Certificates may not be sold in the first Stock Round.");
    game.play(seat, PASS_TURN); // Sell -> Buy
    probe("A: B&O par in SR1", game.refuse(seat, BUY_STOCK(room.state, "B&O", 100), BO_LOCKED_REASON));
    probe("A: SetBoPar in SR1", game.refuse(seat, PAR(seat, 100)));
    for (const player of [A, B, C]) {
      probe(`A: auction buy (${player.slice(-3)})`, game.refuse(player, WF_BUY, noAuction(game, player)));
      game.refuse(player, WF_BID(DH, 75), noAuction(game, player));
      game.refuse(player, WF_PASS, noAuction(game, player));
      game.refuse(player, BEGIN_OR, RT.OPERATING_ROUND_FROM_STOCK_ROUND_REFUSAL);
    }
    // Once PRR is floated and the ordinary IPO remains, an ordinary purchase is still legal: nothing here is a blanket hold.
    game.play(seat, BUY_STOCK(room.state, "PRR"));
  });
});

describe("G-DA B: the Operating Rounds before the trigger", () => {
  it("no auction move is legal early, no private can be bought (none is owned), no round can be forced", () => {
    const game = new Game(restoredAt(G.at("B.or1-nyc")));
    const board = game.state;
    expect([board.current_round_type, tier(board), board.private_auction_complete]).toEqual(["OperatingRound", "2", false]);
    expect(operating(board)?.ticker).toBe("NYC");
    const president = operating(board)!.president!;
    expect(president).toBe(B);
    // At the turn's opening the home-station hold answers first -- the holds outrank every other question (#1613).
    game.refuse(president, BEGIN_OR, /home station/);
    const hex = home(operating(board)!.company_id);
    game.play(president, { PlaceHomeStation: { game_id: 0, company_id: operating(board)!.company_id, q: hex.q, r: hex.r, kind: "home", city_index: null, hex_label: hex.label } });
    game.refuse(president, BEGIN_OR, RT.OPERATING_ROUND_ALREADY_RUNNING_REFUSAL);
    game.refuse(president, OPEN, "The Stock Round is already open.");
    for (const player of [A, B, C]) game.refuse(player, WF_BUY, noAuction(game, player));
    probe("B: BuyPrivateCompany of an unsold private (phase 2)", game.refuse(president, BUY_PRIVATE(game.state, "NYC", SV, 20)));
    game.refuse(president, PAR(president, 100));
    expect(buyablePrivates(game.state)).toBe(false);
  });
});

describe("G-DA C: the first 3-train -- the auction is scheduled, not started", () => {
  it("the phase is 3, the set continues on the PRR, the auction is owed but not armed, and the privates are not for sale", () => {
    const board = G.at("C.trigger").state;
    expect(tier(board)).toBe("3");
    expect(companyOf(board, "NYC").owned_trains).toEqual(["2", "2", "2", "3"]);
    expect([board.current_round_type, board.macro_round_number, operating(board)?.ticker]).toEqual(["OperatingRound", 2, "PRR"]);
    expect(board.private_auction_complete).toBe(false);
    expect(board.waterfall?.waterfall_auction_active).toBe(false);
    // What the shell reads: the Phase 3 notice's "the private company auction is next", and no Buy Private Company.
    expect(pdPending(board)).toBe(true);
    expect(buyablePrivates(board)).toBe(false);
    expect(lockedBo(board)).toBe(true);
  });

  it("during the owed window: no private purchase, no auction move, no forced transition -- and the PRR's own turn still works", () => {
    const game = new Game(restoredAt(G.at("C.prr-hardware")));
    const prr = companyOf(game.state, "PRR");
    expect([prr.president, game.state.operating_sub_phase]).toEqual([A, "Hardware"]);
    probe("C: BuyPrivateCompany in the owed window", game.refuse(A, BUY_PRIVATE(game.state, "PRR", SV, 20)));
    for (const player of [A, B, C]) {
      game.refuse(player, WF_BUY, noAuction(game, player));
      game.refuse(player, BEGIN_OR, RT.OPERATING_ROUND_ALREADY_RUNNING_REFUSAL);
    }
    game.refuse(A, OPEN, "The Stock Round is already open.");
    // Another seat cannot end the PRR's turn for it.
    probe("C: End Turn by another seat", game.refuse(B, PASS_TURN));
    game.play(A, TRAIN(game.state, "PRR"));
    expect(game.state.current_round_type).toBe("WaterfallAuction");
  });
});

describe("G-DA D: the set ends -- the active auction", () => {
  it("opens on the Priority Deal holder, in the macro-round after the set, with all six privates offered", () => {
    const board = G.at("D.auction-open").state;
    expect([board.current_round_type, board.macro_round_number]).toEqual(["WaterfallAuction", 3]);
    expect(board.waterfall?.waterfall_auction_active).toBe(true);
    expect(board.waterfall?.privates.map((entry) => entry.private_id)).toEqual([SV, CS, DH, MH, CA, BO]);
    expect(holderOf(board)).toBe(B); // the card A's SR2 sale moved to B
    expect([actorOf(board), board.waterfall?.current_turn, seatOf(board)]).toEqual([B, B, B]);
    expect(board.private_auction_complete).toBe(false);
    expect(lockedBo(board)).toBe(true);
    // The arming rode on the room's own derived End Turn, after the PRR's limit-filling 3-train.
    const tail = G.at("D.auction-open").entries.slice(-2).map(kindOf);
    expect(tail).toEqual(["BuyHardwareFromPool", "PassTurn*"]);
  });

  it("the Activity Log sentence for the arming entry names the auction and who opens it (DA-F8m), from the real boards", () => {
    const entries = G.at("D.auction-open").entries;
    const before = replayOf(entries.slice(0, -1)).state;
    const after = G.at("D.auction-open").state;
    const context = { gameState: before, afterState: after, mapGrid: { tiles: [] } as never, era: "Green" as never, labelForAddress: (a: string) => a.slice(-3) } as never;
    expect(describeGameplayAction(JSON.parse(entries[entries.length - 1].payload), context)).toBe(
      "PRR ended its turn. The Operating Round set with the first 3-train is over — the delayed private company auction begins, and b02 holds the Priority Deal and acts first.",
    );
  });

  it("refuses the stale and the hostile: BeginOperatingRound, a Stock/Operating Round PassTurn, OR messages, a private purchase, other seats, a spectator", () => {
    const game = new Game(restoredAt(G.at("D.auction-open")));
    const board = game.state;
    for (const player of [A, B, C]) {
      game.refuse(player, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
      game.refuse(player, PASS_TURN, RT.TURN_PASS_IN_AUCTION_REFUSAL);
    }
    probe("D: stale BuyHardwareFromPool", game.refuse(A, TRAIN(board, "PRR")));
    probe("D: stale AdvanceOperatingSubPhase", game.refuse(B, ADVANCE(board, "NYC")));
    probe("D: stale BuyPrivateCompany", game.refuse(B, BUY_PRIVATE(board, "NYC", SV, 20)));
    probe("D: OpenStockRound mid-auction", game.refuse(A, OPEN, /The auction is not over yet — 6 private companies are still for sale\./));
    probe("D: SetBoPar with the BO unsold", game.refuse(A, PAR(A, 100)));
    probe("D: B&O purchase mid-auction", game.refuse(B, BUY_STOCK(board, "B&O", 100)));
    for (const other of [A, C]) {
      probe(`D: other seat buys (${other.slice(-3)})`, game.refuse(other, WF_BUY));
      game.refuse(other, WF_BID(DH, 75));
      game.refuse(other, WF_PASS);
    }
    // A spectator is refused at the transport, before anything is judged.
    const spectator = submitRaw(game.room, SPECTATOR, WF_BUY, { seated: false });
    expect([spectator.kind, spectator.code]).toEqual(["refused", "not-seated"]);
    // The actor's own legal moves: a Pass, then (on the next round of the cursor) a Buy -- each applies.
    expect(game.play(B, WF_PASS)).toEqual(["WaterfallPass"]);
    expect(actorOf(game.state)).toBe(C);
  });

  it("the actor's bid escrows its money; two bids on one private are both held; nothing leaves the table", () => {
    const board = G.at("D.mid-auction").state;
    const dh = board.waterfall!.privates.find((entry) => entry.private_id === DH)!;
    expect(dh.bids).toEqual([
      { bidder: C, bid_amount: "75" },
      { bidder: A, bid_amount: "80" },
    ]);
    expect(money(board)).toBe(G.bank);
    expect(ownerOf(board, SV)).toBe(B);
  });
});

describe("G-DA E: the auction completes", () => {
  it("every private resolves -- the contest's winner pays once, the loser nothing; the C&A's grant changes the PRR's presidency at once", () => {
    const before = G.at("E.before-ca").state;
    const granted = G.at("E.ca-granted").state;
    expect(ownerOf(before, DH)).toBe(C);
    expect(cashOf(G.at("D.contest").state, C) - cashOf(before, C)).toBe(85); // the contest's price, once
    expect(cashOf(G.at("D.contest").state, A)).toBe(cashOf(G.at("E.before-ca").state, A) + 110); // A's lost bid cost him nothing; the M&H $110
    expect([heldBy(before, "PRR", A), heldBy(before, "PRR", C), companyOf(before, "PRR").president]).toEqual([20, 20, A]);
    expect(companyOf(before, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(ownerOf(granted, CA)).toBe(C);
    expect([heldBy(granted, "PRR", A), heldBy(granted, "PRR", C), companyOf(granted, "PRR").president]).toEqual([20, 30, C]);
    expect(companyOf(granted, "PRR").reserved_certificate ?? null).toBeNull();
    expect(companyOf(granted, "PRR").ipo_pool_percentage).toBe(companyOf(before, "PRR").ipo_pool_percentage - 10);
  });

  it("the last private sold: the round waits for the B&O par, and nothing -- not the Stock Round, not an Operating Round -- can jump it", () => {
    const board = G.at("E.last-private").state;
    expect(board.private_companies.map((entry) => [entry.private_id, entry.owner])).toEqual([
      [SV, B],
      [CS, B],
      [DH, C],
      [MH, A],
      [CA, C],
      [BO, A],
    ]);
    expect(board.waterfall?.privates).toEqual([]);
    expect(board.current_round_type).toBe("WaterfallAuction");
    expect(boParOwedTo(board)).toBe(A);
    const game = new Game(restoredAt(G.at("E.last-private")));
    const owed = auctionHandoffRefusal(game.state, game.state.waterfall ?? null)!;
    expect(owed).toMatch(/B&O par comes first/);
    for (const player of [A, B, C]) {
      probe("E: OpenStockRound while the par is owed", game.refuse(player, OPEN, owed));
      game.refuse(player, BEGIN_OR, RT.OPERATING_ROUND_FROM_AUCTION_REFUSAL);
      game.refuse(player, PASS_TURN, RT.TURN_PASS_IN_AUCTION_REFUSAL);
      game.refuse(player, WF_BUY);
    }
    probe("E: SetBoPar by a player who does not own the BO", game.refuse(B, PAR(B, 67)));
    probe("E: SetBoPar naming another player", game.refuse(C, PAR(A, 67)));
    // The owner's par, then the Stock Round -- in that order only.
    expect(game.play(A, PAR(A, 67))).toEqual(["SetBoPar"]);
    expect(companyOf(game.state, "B&O")).toMatchObject({ president: A, par_value: "67" });
    expect(heldBy(game.state, "B&O", A)).toBe(20);
    expect(game.play(B, OPEN)).toEqual(["OpenStockRound"]);
    expect(stateDigest(game.state)).toBe(G.at("F.sr-open").digest); // whoever presses Proceed, the same board
  });

  it("the handoff opens Stock Round 3 once -- the Priority Deal left of the last face-value buyer -- and the auction is over for good", () => {
    const board = G.at("F.sr-open").state;
    expect([board.current_round_type, board.macro_round_number]).toEqual(["StockRound", 3]);
    expect(board.private_auction_complete).toBe(true);
    expect(lockedBo(board)).toBe(false);
    expect(pdPending(board)).toBe(false);
    expect([holderOf(board), seatOf(board)]).toEqual([B, B]); // A bought the BO last, at face
    const game = new Game(restoredAt(G.at("F.sr-open")));
    for (const player of [A, B, C]) {
      probe("E: a second OpenStockRound", game.refuse(player, OPEN, "The Stock Round is already open."));
      game.refuse(player, WF_BUY, noAuction(game, player));
    }
    expect(describeGameplayAction(OPEN as never, {
      gameState: G.at("E.par-set").state, afterState: board, mapGrid: { tiles: [] } as never, era: "Green" as never, labelForAddress: (a: string) => a,
    } as never)).toBe("The delayed private auction is complete — Stock Round 3 begins, and the B&O is now open for trading.");
  });
});

describe("G-DA F: the Stock Round after the auction", () => {
  it("the auction's acquisitions count toward the limits; nothing is owed here; the reserved share is gone, not offered", () => {
    const board = G.at("F.sr-open").state;
    // C's count includes the D&H and the C&A (privates count) and the PRR share the C&A brought.
    const bare = (player: string) =>
      board.public_companies.reduce((sum, company) => sum + company.player_holdings.filter((entry) => entry.player === player).length, 0);
    expect(countOf(board, C)).toBeGreaterThanOrEqual(2);
    expect(countOf(board, C)).toBeGreaterThan(bare(C) - 1);
    for (const player of [A, B, C]) {
      expect([player, divestmentDebt({ state: { ...board, active_player_index: board.player_addresses.indexOf(player) }, player, ...chartForDivestment(board) }).owed]).toEqual([player, false]);
    }
    expect(divestmentPassRefusal(board)).toBeNull();
    for (const company of board.public_companies) {
      expect([company.ticker, company.reserved_certificate ?? null]).toEqual([company.ticker, null]);
      expect([company.ticker, reservedIpoRefusal(company, "Ipo", 10)]).toEqual([company.ticker, null]);
    }
    expect(ordinaryPercentAvailable(companyOf(board, "PRR"), "Ipo")).toBe(companyOf(board, "PRR").ipo_pool_percentage);
  });

  it("the B&O trades, and the C&A's PRR certificate is C's to sell -- a Stock Round after the first is ordinary (S8-7 Q2)", () => {
    const sold = G.at("F.after-ca-sale").state;
    expect(heldBy(sold, "PRR", C)).toBe(20);
    expect(companyOf(sold, "PRR").president).toBe(C); // 20 vs A's 20: the chair stays where it is
    expect(heldBy(sold, "B&O", B)).toBe(10);
    const floated = G.at("G.or3-open").state;
    expect(companyOf(floated, "B&O").is_floated).toBe(true);
    expect(Number(companyOf(floated, "B&O").treasury)).toBe(670);
  });
});

describe("G-DA G: the Operating Round set that follows", () => {
  it("normal ordering resumes (by price), in a two-round phase-3 set; nothing of the auction holds anything", () => {
    const board = G.at("G.or3-open").state;
    expect([board.current_round_type, board.macro_round_number, board.sub_round_index, tier(board)]).toEqual(["OperatingRound", 3, 1, "3"]);
    expect(operatingRoundSequenceLength(board)).toBe(2);
    const prices = board.active_operating_order.map((id) => board.market_positions?.[id]?.price ?? 0);
    expect([...prices].sort((a, b) => b - a)).toEqual(prices);
    expect(board.active_operating_order.map((id) => board.public_companies.find((c) => c.company_id === id)!.ticker).sort()).toEqual(["B&O", "NYC", "PRR"]);
    expect(RT.roundTransitionRefusal(board, PASS_TURN as never)).toBeNull();
    expect(lockedBo(board)).toBe(false);
    expect(buyablePrivates(board)).toBe(true); // Phase 3, privates held by players: the ordinary window is open
  });

  it("a corporation buys a private from its president in the ordinary window; the B&O's first train closes the BO private; the set ends in a Stock Round", () => {
    const game = new Game(restoredAt(G.at("G.or3-open")));
    game.bank = money(game.state);
    let boughtPrivate = false;
    for (let guard = 0; game.state.current_round_type === "OperatingRound"; guard += 1) {
      if (guard > 12) throw new Error("the set did not end");
      const company = operating(game.state)!;
      if (company.ticker === "NYC" && !boughtPrivate) {
        // B presides over the NYC and owns the C&SL: a direct purchase at a price in the band (half to twice face).
        orTurn(game, 0, (g) => {
          boughtPrivate = true;
          probe("G: private purchase above twice face", g.refuse(B, BUY_PRIVATE(g.state, "NYC", CS, 81)));
          g.play(B, BUY_PRIVATE(g.state, "NYC", CS, 80));
          expect(privateOf(g.state, CS)).toMatchObject({ owner_protocol_id: companyOf(g.state, "NYC").company_id });
        });
      } else if (company.ticker === "B&O" && (companyOf(game.state, "B&O").owned_trains ?? []).length === 0) {
        expect(privateOf(game.state, BO).closed).toBeFalsy();
        orTurn(game, 1);
        expect(companyOf(game.state, "B&O").owned_trains).toEqual(["3"]);
        expect(privateOf(game.state, BO).closed).toBe(true); // #660: the B&O's first train closes its private
      } else {
        orTurn(game, 0);
      }
    }
    expect(boughtPrivate).toBe(true);
    // No DA-only hold leaks forward: the set ends in an ordinary Stock Round, never a second auction.
    expect([game.state.current_round_type, game.state.macro_round_number]).toEqual(["StockRound", 4]);
    expect(game.state.private_auction_complete).toBe(true);
    expect(game.state.waterfall?.waterfall_auction_active).toBe(false);
    for (const player of [A, B, C]) game.refuse(player, WF_BUY, noAuction(game, player));
    game.mark("G.sr4-open");
    expectRebuildsAt(game.at("G.sr4-open"), "G.sr4-open");
  });
});

/* ==================================================================================================================== */
/* §8 RESTORE / REPLAY / REVERTTO                                                                                        */
/* ==================================================================================================================== */

describe("restore, replay and one-step RevertTo across the Delayed Auction's boundaries", () => {
  const CUTS = [
    "B.or1-open", // before the first 3-train
    "C.trigger", // after it, before the set ends
    "D.auction-open", // the first active-auction entry
    "D.mid-auction",
    "D.contest",
    "E.last-private", // immediately after the last private; the B&O par owed
    "F.sr-open", // the first entry of the post-auction Stock Round
    "G.or3-open",
  ];
  it.each(CUTS)("%s: the live board == a fresh replay == a serialized restore (twice)", (label) => {
    const restored = expectRebuildsAt(G.at(label), label);
    // A restored room goes on exactly as the live one did: its next legal move is judged the same way.
    expect(ingressOf(restored, actorOf(restored.state), PASS_TURN)).toBe(ingressOf(new Game(restoredAt(G.at(label))).room, actorOf(restored.state), PASS_TURN));
  });

  /** The host's one-step undo of the last decision, then the same decision again: the board must come back to the
   *  mark's exact digest -- same auction actor, same Priority Deal, nothing granted twice. */
  function undoRedo(label: string, redo: (game: Game) => void, check?: (undone: State) => void) {
    const game = new Game(restoredAt(G.at(label)));
    game.bank = G.bank;
    const last = [...effectiveActions(game.room.entries)].reverse().find((entry) => !entry.derived)!;
    expect(game.play(A, REVERT(last.index, A))[0]).toBe("RevertTo");
    const undone = game.state;
    check?.(undone);
    redo(game);
    expect([label, stateDigest(game.state)]).toEqual([label, G.at(label).digest]);
    expect(authority(game.state)).toEqual(authority(G.at(label).state));
    return undone;
  }

  it("undo the purchase that armed the auction: back in the Operating Round, nothing armed; the same purchase re-arms it on the same opener", () => {
    undoRedo(
      "D.auction-open",
      (game) => game.play(A, TRAIN(game.state, "PRR")),
      (undone) => {
        expect([undone.current_round_type, operating(undone)?.ticker, undone.operating_sub_phase]).toEqual(["OperatingRound", "PRR", "Hardware"]);
        expect(undone.waterfall?.waterfall_auction_active).toBe(false);
        expect(undone.private_auction_complete).toBe(false);
      },
    );
  });

  it("undo a mid-auction purchase: the private is offered again, the money back, the same actor to move", () => {
    undoRedo(
      "D.after-first-buy",
      (game) => auctionStep(game, "buy", B),
      (undone) => {
        expect(ownerOf(undone, SV)).toBeNull();
        expect(undone.waterfall?.privates).toHaveLength(6);
        expect(actorOf(undone)).toBe(B);
        expect(cashOf(undone, B)).toBe(cashOf(G.at("D.auction-open").state, B));
      },
    );
  });

  it("undo the C&A's purchase: the reserved certificate and the presidency come back; redone, granted once", () => {
    undoRedo(
      "E.ca-granted",
      (game) => auctionStep(game, "buy", C),
      (undone) => {
        expect(ownerOf(undone, CA)).toBeNull();
        expect(companyOf(undone, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
        expect([heldBy(undone, "PRR", C), companyOf(undone, "PRR").president]).toEqual([20, A]);
      },
    );
  });

  it("undo the last private: the auction is live again on A with one private, not resurrected whole; no grant is duplicated", () => {
    undoRedo(
      "E.last-private",
      (game) => auctionStep(game, "buy", A),
      (undone) => {
        expect(undone.waterfall?.privates.map((entry) => entry.private_id)).toEqual([BO]);
        expect(undone.waterfall?.waterfall_auction_active).toBe(true);
        expect(actorOf(undone)).toBe(A);
        expect(heldBy(undone, "PRR", C)).toBe(30); // the C&A's certificate, once
        expect(boParOwedTo(undone)).toBeNull();
      },
    );
  });

  it("undo the B&O par: the par is owed again and the Stock Round cannot open around it", () => {
    undoRedo(
      "E.par-set",
      (game) => {
        game.refuse(B, OPEN, /B&O par comes first/);
        game.play(A, PAR(A, 67));
      },
      (undone) => expect(boParOwedTo(undone)).toBe(A),
    );
  });

  it("undo the handoff: the completed auction's board, not a live auction; Proceed again lands on the same Stock Round and Priority Deal", () => {
    undoRedo(
      "F.sr-open",
      (game) => game.play(C, OPEN),
      (undone) => {
        expect(undone.current_round_type).toBe("WaterfallAuction");
        expect(undone.waterfall?.privates).toEqual([]);
        expect(undone.private_companies.every((entry) => entry.owner !== null)).toBe(true);
      },
    );
  });

  it("the alternate history: undo the NYC's first 3-train, let the LAST corporation buy it instead -- the auction still arms at the set's end", () => {
    const game = new Game(restoredAt(G.at("C.trigger")));
    const last = [...effectiveActions(game.room.entries)].reverse().find((entry) => !entry.derived)!;
    expect(kindOf(last)).toBe("BuyHardwareFromPool");
    game.play(A, REVERT(last.index, A));
    expect([tier(game.state), operating(game.state)?.ticker, game.state.operating_sub_phase]).toEqual(["2", "NYC", "Hardware"]);
    expect(pdPending(game.state)).toBe(true);
    game.play(B, PASS_TURN); // the NYC ends its turn without a train
    expect(operating(game.state)?.ticker).toBe("PRR");
    orTurn(game, 1); // the PRR buys the first 3-train as the set's last corporation
    expect([game.state.current_round_type, game.state.macro_round_number, actorOf(game.state)]).toEqual(["WaterfallAuction", 3, B]);
    expect(game.state.waterfall?.privates).toHaveLength(6);
  });

  it("a deep jump across a boundary is refused -- the only undo is one step (RV-6), so no boundary is crossed by a bypass", () => {
    const game = new Game(restoredAt(G.at("D.mid-auction")));
    const trigger = G.at("C.trigger").entries.length - 2; // the NYC's 3-train purchase
    expect(kindOf(G.at("C.trigger").entries[trigger])).toBe("BuyHardwareFromPool");
    game.refuse(A, REVERT(trigger, A), REVERT_ONE_STEP);
  });
});

/* ==================================================================================================================== */
/* §9 ROOM PARITY and §13 ADVERSARIAL                                                                                    */
/* ==================================================================================================================== */

describe("room / reducer / ingress parity and the adversarial probes at the auction's boundaries", () => {
  it("every refusal this file asserted was made at all three layers (recorded above), with a sentence", () => {
    expect(probes.length).toBeGreaterThan(20);
    for (const entry of probes) expect([entry.label, entry.reason.length > 0]).toEqual([entry.label, true]);
    // The sender-only refusals seen so far are exactly the three sender questions -- no RULE is ingress-only.
    expect(seatOnly.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    if (process.env.DA7_REPORT) console.log(["sender-only refusals:", ...Array.from(new Set(seatOnly))].join("\n"));
  });

  it("a duplicate auction answer: the same submission retried is its own catch-up; a second press is not the presser's turn", () => {
    const room = restoredAt(G.at("D.auction-open"));
    const first = submitRaw(room, B, WF_BUY, { submissionId: "buy-sv" });
    expect(first.kind).toBe("applied");
    const length = room.entries.length;
    const digest = stateDigest(room.state);
    const retry = room.submit({ actor: B, build: BUILD, msg: WF_BUY as never, baseIndex: length - 2, host: A, submissionId: "buy-sv", seated: true } as never) as { kind: string; entries?: ServerLogEntry[] };
    expect(retry.kind).toBe("catch-up");
    expect([room.entries.length, stateDigest(room.state)]).toEqual([length, digest]);
    const again = submitRaw(room, B, WF_BUY, { submissionId: "buy-sv-2" });
    expect(again.kind).toBe("refused");
    expect([room.entries.length, stateDigest(room.state), cashOf(room.state, B)]).toEqual([length, digest, cashOf(G.at("D.after-first-buy").state, B)]);
  });

  it("the final private delivered twice, and racing the par: charged once; the Stock Round waits for the par either way", () => {
    const room = restoredAt(G.at("E.ca-granted"));
    expect(submitRaw(room, A, WF_BUY, { submissionId: "last" }).kind).toBe("applied");
    const settled = { length: room.entries.length, digest: stateDigest(room.state) };
    expect(stateDigest(room.state)).toBe(G.at("E.last-private").digest);
    expect(room.submit({ actor: A, build: BUILD, msg: WF_BUY as never, baseIndex: settled.length - 2, host: A, submissionId: "last", seated: true } as never).kind).toBe("catch-up");
    expect([room.entries.length, stateDigest(room.state)]).toEqual([settled.length, settled.digest]);
    for (const player of [A, B, C]) expect(submitRaw(room, player, OPEN).kind).toBe("refused");
    expect([room.entries.length, stateDigest(room.state)]).toEqual([settled.length, settled.digest]);
  });

  it("reconnect at the auction's completion: the catch-up from any point rebuilds the same board", () => {
    const room = restoredAt(G.at("E.last-private"));
    for (const from of [-1, 10, G.at("D.auction-open").entries.length - 1]) {
      const caught = room.catchUp(from) as { kind: string; entries: ServerLogEntry[] };
      expect(caught.kind).toBe("catch-up");
      const prefix = (room.entries as ServerLogEntry[]).filter((entry) => entry.index <= from);
      expect(stateDigest(replayOf([...prefix, ...caught.entries]).state)).toBe(G.at("E.last-private").digest);
    }
  });

  it("restore while the B&O par is owed: still owed, still A's, and the Stock Round opens only after it", () => {
    const game = new Game(restoredAt(G.at("E.last-private")));
    expect(boParOwedTo(game.state)).toBe(A);
    game.refuse(C, OPEN, /B&O par comes first/);
    game.play(A, PAR(A, 67));
    game.play(C, OPEN);
    expect(stateDigest(game.state)).toBe(G.at("F.sr-open").digest);
  });

  it("C2-02 at the auction: a repeated stale consent answer from an unrelated seat is settled, never recorded", () => {
    const room = restoredAt(G.at("D.mid-auction"));
    const answer = { AnswerPrivatePurchase: { game_id: 0, private_id: DH, accept: true } };
    expect(harmlessDuplicateAnswer(room.state, answer)).toBe(true);
    const before = { length: room.entries.length, digest: stateDigest(room.state) };
    for (let n = 0; n < 4; n += 1) {
      expect(submitRaw(room, C, answer)).toMatchObject({ kind: "refused", reason: HARMLESS_DUPLICATE_ANSWER_SENTENCE });
    }
    expect([room.entries.length, stateDigest(room.state)]).toEqual([before.length, before.digest]);
    // The auction's own next move still belongs to the actor and applies.
    expect(submitRaw(room, actorOf(room.state), WF_BUY).kind).toBe("applied");
  });

  it("a malformed auction frame is stopped by the schema; the legal frame after it applies", () => {
    expect(validateGameplayMessage({ WaterfallBidHigher: { game_id: 0, private_id: "D&H", bid_amount: 75 } }).ok).toBe(false);
    expect(validateGameplayMessage({ WaterfallBuyLowest: { game_id: 0, extra: { nested: true } } }).ok).toBe(true); // stripped, not refused
    expect(validateGameplayMessage(WF_BUY).ok).toBe(true);
    const room = restoredAt(G.at("D.auction-open"));
    expect(submitRaw(room, B, WF_BUY).kind).toBe("applied");
    expect(stateDigest(room.state)).toBe(G.at("D.after-first-buy").digest);
  });
});

/* ==================================================================================================================== */
/* TAILS                                                                                                                 */
/* ==================================================================================================================== */

/** Plays a Delayed Auction game from the deal to its armed auction: Stock Round 1 by `sr1` (one ticker per turn, the
 *  first purchase of a ticker at `par`), Operating Round 1 buying three 2-trains each, a passed Stock Round 2, and
 *  Operating Round 2 in which the first corporation buys the first 3-train and the next one a second. */
function toAuction(sr1: ReadonlyArray<string | "pass">, par = 100, check?: (game: Game) => void, extra: Record<string, unknown> = {}): Game {
  const game = dealt(true, extra);
  const started = new Set<string>();
  for (const turn of sr1) {
    if (turn === "pass") passTurn(game);
    else {
      buyTurn(game, turn, started.has(turn) ? undefined : par);
      started.add(turn);
    }
  }
  check?.(game);
  finishStockRound(game);
  while (inOperating(game)) orTurn(game, 3);
  check?.(game);
  finishStockRound(game);
  while (inOperating(game)) orTurn(game, 1);
  expect(game.state.current_round_type).toBe("WaterfallAuction");
  return game;
}

describe("T3: the C&A when the PRR's ordinary IPO is exhausted -- the last 10% is the C&A buyer's and no one else's", () => {
  const RESERVED_SENTENCE =
    "The 10% of PRR left in the IPO is held for whoever buys the C&A in the delayed private company auction — no one else can buy it.";
  let game: Game;
  const refusals: string[] = [];
  beforeAll(() => {
    // PRR sold to 90% (A 40, B 30, C 20); the NYC floated beside it.
    game = toAuction(["PRR", "PRR", "PRR", "PRR", "PRR", "NYC", "PRR", "PRR", "PRR", "NYC", "NYC", "NYC", "NYC"], 100, (g) => {
      if (g.state.current_round_type !== "StockRound") return;
      const prr = companyOf(g.state, "PRR");
      expect([prr.ipo_pool_percentage, prr.bank_pool_percentage, ordinaryPercentAvailable(prr, "Ipo")]).toEqual([10, 0, 0]);
      const seat = seatOf(g.state);
      g.play(seat, PASS_TURN); // Sell -> Buy
      refusals.push(g.refuse(seat, BUY_STOCK(g.state, "PRR"), RESERVED_SENTENCE));
      expect(reservedIpoRefusal(companyOf(g.state, "PRR"), "Ipo", 10)).toBe(RESERVED_SENTENCE);
      g.play(seat, PASS_TURN);
    });
  });

  it("is refused to every ordinary buyer with DA6-N2's sentence, in Stock Round 1 and in Stock Round 2, at all three layers", () => {
    expect(refusals).toEqual([RESERVED_SENTENCE, RESERVED_SENTENCE]);
  });

  it("goes to the C&A's buyer in the auction -- the IPO's last certificate, nothing minted, the company at 100%", () => {
    const prrBefore = companyOf(game.state, "PRR");
    expect(prrBefore.ipo_pool_percentage).toBe(10);
    for (let guard = 0; ownerOf(game.state, CA) === null; guard += 1) {
      if (guard > 12) throw new Error("the C&A was not sold");
      auctionStep(game, "buy");
    }
    const buyer = ownerOf(game.state, CA)!;
    const prr = companyOf(game.state, "PRR");
    expect(prr.ipo_pool_percentage).toBe(0);
    expect(prr.reserved_certificate ?? null).toBeNull();
    expect(prr.player_holdings.reduce((sum, entry) => sum + entry.percentage, 0)).toBe(100);
    expect(heldBy(game.state, "PRR", buyer) - (prrBefore.player_holdings.find((entry) => entry.player === buyer)?.percentage ?? 0)).toBe(10);
    game.mark("T3.granted");
    expectRebuildsAt(game.at("T3.granted"), "T3.granted");
  });
});

describe("T4: an auction purchase that creates a curable overage -- the must-sell hold, cured, never a permanent hold", () => {
  let game: Game;
  beforeAll(() => {
    // A and B float the NYC; C alone buys the PRR to 60% (its president).
    game = toAuction(["NYC", "NYC", "PRR", "NYC", "NYC", "PRR", "NYC", "pass", "PRR", "pass", "pass", "PRR", "pass", "pass", "PRR"]);
    expect([heldBy(game.state, "PRR", C), companyOf(game.state, "PRR").president]).toEqual([60, C]);
  });

  it("C's C&A purchase is allowed (curable: a 10% can go to the pool next Stock Round) and puts C at 70%", () => {
    for (let guard = 0; game.state.waterfall!.privates.length > 0; guard += 1) {
      if (guard > 20) throw new Error("the auction did not finish");
      const lowest = game.state.waterfall!.privates[0].private_id;
      const actor = actorOf(game.state);
      // C waits for the C&A (passing on everything below it); A and B buy everything but the C&A.
      auctionStep(game, actor === C ? (lowest === CA ? "buy" : "pass") : lowest === CA ? "pass" : "buy");
    }
    expect(ownerOf(game.state, CA)).toBe(C);
    expect(heldBy(game.state, "PRR", C)).toBe(70);
    const owner = boParOwedTo(game.state)!;
    game.play(owner, PAR(owner, 67));
    game.play(owner, OPEN);
    expect(game.state.current_round_type).toBe("StockRound");
  });

  it("on C's turn: Pass and Buy are refused with the Delayed Auction's sentence until the curable part is sold; then the turn goes on", () => {
    for (let guard = 0; seatOf(game.state) !== C; guard += 1) {
      if (guard > 3) throw new Error("C's turn never came");
      passTurn(game);
    }
    const held = game.state;
    const debt = divestmentDebt({ state: held, player: C, ...chartForDivestment(held) });
    expect(debt.owed).toBe(true);
    const sentence = divestmentPassRefusal(held)!;
    expect(sentence).toMatch(/At this table a private company won in the delayed auction/);
    expect(sentence).toMatch(/over the 60% cap in PRR/);
    game.refuse(C, PASS_TURN, sentence);
    game.refuse(C, BUY_STOCK(held, "NYC"), sentence);
    game.mark("T4.held");
    expectRebuildsAt(game.at("T4.held"), "T4.held");
    game.play(C, SELL(held, "PRR", 10));
    game.mark("T4.cured");
    expect(heldBy(game.state, "PRR", C)).toBe(60);
    expect(divestmentPassRefusal(game.state)).toBeNull();
    // Undo the sale: the hold is back (not lost); sell again: gone (not stale).
    const sale = [...effectiveActions(game.room.entries)].reverse().find((entry) => !entry.derived)!;
    game.play(A, REVERT(sale.index, A));
    expect(divestmentPassRefusal(game.state)).toBe(sentence);
    game.play(C, SELL(game.state, "PRR", 10));
    expect(stateDigest(game.state)).toBe(game.at("T4.cured").digest);
    game.play(C, PASS_TURN); // Sell -> Buy
    game.play(C, PASS_TURN); // the turn ends: no hold remains
    expect(seatOf(game.state)).not.toBe(C);
  });
});

describe("T5 / D-55: the first 5-train before the auction cancels it -- through the room, and for good", () => {
  /* THE PHASE-5 EVE, constructed as DA-5's was (`da5PrivateConsequences.test.ts`, `phaseFiveEve`), on this file's REAL
     Stock Round 2 board: the first 3-train's set has run on to its last train of Phase 4 -- every 4-train owned (NYC
     one, PRR one, CPR two) -- and the auction it owes has not happened. Only the fleets, the cursor and three treasuries
     are set; the holdings, the chart, the privates, the reservation and the deal are the real run's. */
  function eve(): State {
    const real = G.at("B.sr2-open").state;
    const board = {
      ...real,
      current_round_type: "OperatingRound",
      sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["4"] }] } as never),
      active_operating_order: [companyOf(real, "NYC").company_id],
      active_corporation_index: 0,
      active_player_index: real.player_addresses.indexOf(B),
      operating_sub_phase: "Hardware",
      public_companies: real.public_companies.map((company) => {
        if (company.ticker === "NYC") return { ...company, owned_trains: ["4"], treasury: "1000" };
        if (company.ticker === "PRR") return { ...company, owned_trains: ["4"] };
        if (company.ticker === "CPR") {
          return { ...company, is_floated: true, president: C, par_value: "100", treasury: "1000", owned_trains: ["4", "4"], player_holdings: [{ player: C, percentage: 60 }], ipo_pool_percentage: 40 };
        }
        return company;
      }),
    } as State;
    return board;
  }
  const providersFor = (board: State) => ({ ...sandboxReplayProviders(), ...(board.market_positions ? { initialMarket: board.market_positions } : {}) });

  it("cancels at the purchase: unsold privates closed, the auction never arms, the reservation released, the B&O unlocked; no later set re-arms it", () => {
    const start = eve();
    expect([tier(start), start.private_auction_complete, lockedBo(start)]).toEqual(["4", false, true]);
    const game = new Game(newRoom({ state: start, waterfall: start.waterfall ?? null }, providersFor(start)), { state: start, waterfall: start.waterfall ?? null }, providersFor(start));
    game.bank = money(start);
    const kinds = game.play(B, TRAIN(start, "NYC")); // the first 5-train
    expect(kinds[0]).toBe("BuyHardwareFromPool");
    game.mark("T5.after-five");
    const opened = game.state;
    expect(tier(opened)).toBe("5");
    expect(opened.private_companies.map((entry) => [entry.private_id, !!entry.closed, entry.owner ?? null])).toEqual(
      [SV, CS, DH, MH, CA, BO].map((id) => [id, true, null]),
    );
    expect(opened.private_auction_complete).toBe(true);
    expect([opened.current_round_type, opened.waterfall?.waterfall_auction_active, opened.waterfall?.privates]).toEqual(["StockRound", false, []]);
    expect(companyOf(opened, "PRR").reserved_certificate ?? null).toBeNull();
    expect(lockedBo(opened)).toBe(false);
    expect(pdPending(opened)).toBe(false);
    // The shell's Phase 5 line carries the cancellation clause exactly when this transition happens (DA-6, App.tsx).
    expect(start.private_auction_complete === false && opened.private_auction_complete === true).toBe(true);
    // No auction can be entered: every auction message, every seat, at all three layers.
    for (const player of [A, B, C]) {
      game.refuse(player, WF_BUY, noAuction(game, player));
      game.refuse(player, WF_BID(BO, 225), noAuction(game, player));
      game.refuse(player, OPEN, "The Stock Round is already open.");
    }
    // What the cancellation freed trades the ordinary way: the ex-reserved PRR certificate and the B&O.
    expect(ordinaryPercentAvailable(companyOf(opened, "PRR"), "Ipo")).toBe(companyOf(opened, "PRR").ipo_pool_percentage);
    expect(seatOf(opened)).toBe(holderOf(opened));
    buyTurn(game, "B&O", 100);
    expect(companyOf(game.state, "B&O").president).toBe(holderOf(opened));
    finishStockRound(game);
    // The next set, played to its end, opens a Stock Round -- a finished (cancelled) auction is never inserted.
    for (let guard = 0; game.state.current_round_type === "OperatingRound"; guard += 1) {
      if (guard > 30) throw new Error("the set did not end");
      orTurn(game, 0);
    }
    expect(game.state.current_round_type).toBe("StockRound");
    expect(game.state.private_auction_complete).toBe(true);
    game.mark("T5.next-sr");
    for (const label of ["T5.after-five", "T5.next-sr"]) {
      expectRebuildsAt(game.at(label), label, { state: start, waterfall: start.waterfall ?? null }, providersFor(start));
    }
  });

  it("one-step undo of the 5-train restores the pending auction exactly; the purchase again cancels it again", () => {
    const start = eve();
    const room = newRoom({ state: start, waterfall: start.waterfall ?? null }, providersFor(start));
    const game = new Game(room, { state: start, waterfall: start.waterfall ?? null }, providersFor(start));
    game.play(B, TRAIN(start, "NYC"));
    const cancelled = stateDigest(game.state);
    const five = [...effectiveActions(room.entries)].reverse().find((entry) => !entry.derived)!;
    game.play(A, REVERT(five.index, A));
    expect(stateDigest(game.state)).toBe(stateDigest(start));
    expect([game.state.private_auction_complete, game.state.waterfall?.privates.length]).toEqual([false, 6]);
    expect(companyOf(game.state, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    game.play(B, TRAIN(game.state, "NYC"));
    expect(stateDigest(game.state)).toBe(cancelled);
  });
});

/* ==================================================================================================================== */
/* §10 VARIANT ISOLATION -- the standard game, played the same way                                                       */
/* ==================================================================================================================== */

describe("variant isolation: the standard game's round flow, privates and B&O are untouched", () => {
  it("the auction opens the game on seat 0; nothing is reserved or locked; the first 3-train's set ends in a Stock Round, not an auction", () => {
    const game = dealt(false);
    const deal = game.state;
    expect([deal.current_round_type, deal.macro_round_number, actorOf(deal)]).toEqual(["WaterfallAuction", 1, A]);
    expect(deal.waterfall?.waterfall_auction_active).toBe(true);
    expect(deal.public_companies.filter((company) => company.reserved_certificate)).toEqual([]);
    expect(lockedBo(deal)).toBe(false);
    expect(pdPending(deal)).toBe(false);
    for (let guard = 0; (game.state.waterfall?.privates.length ?? 0) > 0; guard += 1) {
      if (guard > 12) throw new Error("the auction did not finish");
      auctionStep(game, "buy");
    }
    const owner = boParOwedTo(game.state)!;
    game.play(owner, PAR(owner, 67));
    game.play(owner, OPEN);
    expect([game.state.current_round_type, game.state.macro_round_number, game.state.private_auction_complete]).toEqual(["StockRound", 1, true]);
    // The same two floats as G-DA, turn for turn (whoever is seated), then the same trains.
    for (const turn of ["PRR", "NYC", "PRR", "PRR", "NYC", "NYC", "PRR", "NYC", "NYC", "PRR"]) {
      const started = companyOf(game.state, turn).president !== null;
      buyTurn(game, turn, started ? undefined : 100);
    }
    finishStockRound(game);
    while (inOperating(game)) orTurn(game, 3);
    finishStockRound(game);
    while (inOperating(game)) orTurn(game, 1);
    expect(tier(game.state)).toBe("3");
    expect([game.state.current_round_type, game.state.macro_round_number]).toEqual(["StockRound", 3]);
    expect(game.state.waterfall?.waterfall_auction_active).toBe(false);
    // Standard-only auction mechanics stay out of the Delayed Auction: its opener was the Priority Deal holder (D),
    // not seat 0, and its privates paid nothing before they were sold (G-DA's OR1 and OR2 held no owner).
    expect(actorOf(G.at("D.auction-open").state)).not.toBe(A);
    expect(G.at("B.sr2-open").state.private_companies.every((entry) => entry.owner === null)).toBe(true);
  });
});

/* ==================================================================================================================== */
/* §12 DA6-O1 / DA6-O2 -- the two LOW copy findings, corrected here; and the D-55 narration the shell prints            */
/* ==================================================================================================================== */

describe("player-facing rules text the certification leaves correct", () => {
  const tutorial = readStripped("components/TutorialModal.tsx");
  const rules = readStripped("components/RulesReference.tsx");
  const app = readShell();

  it("DA6-O1: the auction tutorial's all-pass page states §1.2.3's two EXCLUSIVE outcomes -- the SV alone is marked down", () => {
    expect(tutorial).toContain("one of two things happens before your turn comes back");
    expect(tutorial).toContain("While the Schuylkill Valley is still unsold, its price drops by $5");
    expect(tutorial).toContain("Once the Schuylkill Valley has been bought, no price drops.");
    expect(tutorial).not.toContain("three things happen");
    expect(tutorial).not.toContain("The face value of the lowest unowned private company drops by $5");
    expect(tutorial).not.toContain("A private you keep refusing eventually");
  });

  it("DA6-O2: the Stock page's limit rule carries DA-5's common curable-only qualifier", () => {
    expect(rules).toContain(
      "A player pushed over a limit must sell down on their next Stock Round turn, before buying or passing — as far as a legal sale can fix it; an excess no legal sale could cure is not owed.",
    );
  });

  it("D-55: the Phase 5 closure line names the cancellation exactly on the transition T5 certifies", () => {
    expect(app).toContain("before.private_auction_complete === false && after.private_auction_complete === true");
    expect(app).toContain("The delayed private company auction will not be held, and the B&O is now open for trading.");
  });
});

/* ==================================================================================================================== */
/* DA-T10 (in part): the variant beside Gentle Rust and Unpredictable Revenue on the trigger set                        */
/* ==================================================================================================================== */

describe("composition (DA-T10, in part): Gentle Rust + Unpredictable Revenue do not move the trigger, the arming or the opener", () => {
  it("the same two floats and the same trains arm the auction at the same boundary, on the same Priority Deal holder", () => {
    const script = ["PRR", "NYC", "PRR", "PRR", "NYC", "NYC", "PRR", "NYC", "PRR", "NYC"];
    const plain = toAuction(script);
    const composed = toAuction(script, 100, undefined, { gentleRust: true, unpredictableRevenue: true });
    expect(resolveVariants(composed.state.variants)).toMatchObject({ delayedAuction: true, gentleRust: true, unpredictableRevenue: true });
    const at = (board: State) => ({
      round: board.current_round_type,
      macro: board.macro_round_number,
      opener: actorOf(board),
      holder: holderOf(board),
      offered: board.waterfall?.privates.map((entry) => entry.private_id),
      reserved: companyOf(board, "PRR").reserved_certificate ?? null,
      phase: tier(board),
      fleets: board.public_companies.map((company) => [company.ticker, company.owned_trains]),
    });
    expect(at(composed.state)).toEqual(at(plain.state));
    expect(composed.room.entries.map(kindOf)).toEqual(plain.room.entries.map(kindOf)); // the same log, entry for entry
    const mark = composed.mark("DA-T10.armed");
    expectRebuildsAt(mark, "DA-T10.armed");
  });
});

/* ==================================================================================================================== */
/* DA-T6: A CONTEST THAT CASCADES INTO A CONTEST -- delayed, and the standard control                                   */
/* ==================================================================================================================== */

/** From an auction whose SV is sold and whose five other privates stand unbid: two bids on the D&H and two on the M&H,
 *  then a face-value purchase of the C&SL. The cascade reaches the D&H (two bids: a contest), whose award cascades on to
 *  the M&H (two bids: a SECOND contest, opened by the first one's resolution), whose award cascades on to the C&A (no
 *  bids: the cascade stops and the main rotation resumes). Returns who did what. */
function contestIntoContest(game: Game) {
  const w = () => game.state.waterfall!;
  expect(w().privates.map((entry) => entry.private_id)).toEqual([CS, DH, MH, CA, BO]);
  expect(w().privates.every((entry) => entry.bids.length === 0)).toBe(true);
  const first = auctionStep(game, ["bid", DH, 75]);
  const second = auctionStep(game, ["bid", DH, 80]);
  const third = auctionStep(game, ["bid", MH, 115]);
  expect(auctionStep(game, ["bid", MH, 120])).toBe(first); // three seats: the first bidder bids on both
  const cash0 = Object.fromEntries([A, B, C].map((player) => [player, cashOf(game.state, player)]));
  const buyer = auctionStep(game, "buy"); // the C&SL at face -- the chain of a DIRECT purchase
  expect(buyer).toBe(second);
  expect(ownerOf(game.state, CS)).toBe(buyer);

  // CONTEST 1, on the D&H: its two bidders, lowest first; the main rotation frozen; only a bidder answers.
  expect(w().mini_auction).toMatchObject({ private_id: DH, bidders: [first, second], high_bidder: second, high_bid: "80", current_turn: first });
  game.mark("T6.contest-1");
  for (const player of [A, B, C]) {
    game.refuse(player, WF_BUY);
    game.refuse(player, WF_PASS);
    game.refuse(player, WF_BID(CA, 165));
  }
  game.refuse(third, WF_RAISE(90)); // not a bidder in this contest
  game.refuse(second, WF_RAISE(90)); // the high bidder's own turn is skipped
  auctionStep(game, ["raise", 85], first);
  auctionStep(game, "mini-pass", second); // FIRST wins the D&H at $85 -- and the cascade goes on

  // CONTEST 2, opened by contest 1's award: the M&H's two bidders, lowest first -- nobody sent anything to open it.
  expect(ownerOf(game.state, DH)).toBe(first);
  expect(w().privates.map((entry) => entry.private_id)).toEqual([MH, CA, BO]);
  expect(w().mini_auction).toMatchObject({ private_id: MH, bidders: [third, first], high_bidder: first, high_bid: "120", current_turn: third });
  game.mark("T6.contest-2");
  for (const player of [A, B, C]) game.refuse(player, WF_BUY);
  game.refuse(second, WF_RAISE(125)); // not a bidder in THIS contest
  game.refuse(first, WF_MINI_PASS); // the high bidder waits
  auctionStep(game, ["raise", 125], third);
  auctionStep(game, "mini-pass", first); // THIRD wins the M&H at $125; the C&A has no bid: the cascade stops

  expect(ownerOf(game.state, MH)).toBe(third);
  expect(w().mini_auction ?? null).toBeNull();
  expect(w().privates.map((entry) => entry.private_id)).toEqual([CA, BO]);
  // Each winner paid his winning bid once; each loser nothing; the direct buyer his face value -- and nothing else moved.
  expect(cashOf(game.state, first)).toBe(cash0[first] - 85);
  expect(cashOf(game.state, second)).toBe(cash0[second] - 40);
  expect(cashOf(game.state, third)).toBe(cash0[third] - 125);
  // The main rotation resumes where the direct purchase left it -- on the buyer's left -- as after one contest (DA-4).
  const left = (player: string) => game.state.player_addresses[(game.state.player_addresses.indexOf(player) + 1) % 3];
  expect(actorOf(game.state)).toBe(left(buyer));
  game.mark("T6.resumed");
  return { first, second, third, buyer, left };
}

describe("DA-T6: a contest that cascades into a contest -- the Delayed Auction, through the room", () => {
  let game: Game;
  let who: ReturnType<typeof contestIntoContest>;
  beforeAll(() => {
    game = new Game(restoredAt(G.at("D.after-first-buy")));
    game.bank = G.bank;
    who = contestIntoContest(game);
  });

  it("the first contest's award opens the second at once; each winner pays once, each loser nothing; the rotation resumes left of the direct buyer", () => {
    expect([who.first, who.second, who.third, who.buyer]).toEqual([C, A, B, A]);
    expect(actorOf(game.state)).toBe(B);
  });

  it("both contests, and the resumption, rebuild exactly: live == replay == restore", () => {
    for (const label of ["T6.contest-1", "T6.contest-2", "T6.resumed"]) expectRebuildsAt(game.at(label), label);
  });

  it("one-step undo of the award that opened contest 2 puts contest 1 back, open, on its answerer; the same answer reopens contest 2 exactly", () => {
    const again = new Game(restoredAt(game.at("T6.contest-2")));
    const last = [...effectiveActions(again.room.entries)].reverse().find((entry) => !entry.derived)!;
    expect(kindOf(last)).toBe("WaterfallMiniAuctionPass");
    again.play(A, REVERT(last.index, A));
    expect(again.state.waterfall?.mini_auction).toMatchObject({ private_id: DH, high_bidder: C, high_bid: "85", current_turn: A });
    expect(ownerOf(again.state, DH)).toBeNull();
    again.play(A, WF_MINI_PASS);
    expect(stateDigest(again.state)).toBe(game.at("T6.contest-2").digest);
  });

  it("the auction then ends the ordinary way: the Priority Deal left of the last DIRECT purchaser, not of a contest's winner", () => {
    const rest = new Game(restoredAt(game.at("T6.resumed")));
    rest.bank = G.bank;
    const buyers: string[] = [];
    for (let guard = 0; rest.state.waterfall!.privates.length > 0; guard += 1) {
      if (guard > 6) throw new Error("the auction did not finish");
      buyers.push(auctionStep(rest, "buy"));
    }
    const owner = boParOwedTo(rest.state)!;
    rest.play(owner, PAR(owner, 67));
    rest.play(owner, OPEN);
    const lastDirect = buyers[buyers.length - 1];
    expect([rest.state.current_round_type, rest.state.macro_round_number]).toEqual(["StockRound", 3]);
    expect(holderOf(rest.state)).toBe(who.left(lastDirect));
  });
});

describe("DA-T6 standard control: the same contest-into-contest in the opening auction", () => {
  it("behaves identically -- the delayed variant adds nothing to the cascade", () => {
    const game = dealt(false);
    auctionStep(game, "buy", A); // A buys the SV; the five others stand unbid
    const who = contestIntoContest(game);
    expect([who.first, who.second, who.third, who.buyer]).toEqual([B, C, A, C]);
    expect(actorOf(game.state)).toBe(A);
    expectRebuildsAt(game.at("T6.contest-2"), "standard T6.contest-2");
  });
});

/* ==================================================================================================================== */
/* DA-T11: THE BANK BREAKS INSIDE THE OPERATING ROUND SET THAT OWES THE DELAYED AUCTION                                 */
/* ==================================================================================================================== */

describe("DA-T11: a bank break inside the trigger set -- the set finishes, the game ends, the owed auction never runs", () => {
  /* THE BOARD: G-DA's real "C.trigger" -- the NYC has just bought the FIRST 3-train, the set continues on the PRR, the
     auction is owed (phase 3, `private_auction_complete` false, the atom dormant with six privates, the C&A's PRR share
     reserved). CONSTRUCTED on it, as UR-3's harness constructs its network (`yellowSignRunBoundSupport.ts`): the C&O,
     floated under C (60%, par $67, treasury $670, one 2-train), stationed on I5 of the Gulf line and inserted between
     the NYC and the PRR in this set's order; the Gulf line's tiles (the room's grid); and the bank at $20. So the break
     is REAL: the C&O runs I5-I3-J2 through the room and a distributed dividend takes the bank past zero -- the latch
     `debitBank` sets (#1561). Everything else is the real run's. */
  function breakEve(bank = 20): { start: Start; providers: object } {
    const real = G.at("C.trigger").state;
    const co = companyOf(real, "C&O");
    const nyc = companyOf(real, "NYC").company_id;
    const prr = companyOf(real, "PRR").company_id;
    const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
    const state = {
      ...real,
      virtual_bank_vgp: String(bank),
      active_operating_order: [nyc, co.company_id, prr],
      active_corporation_index: 1,
      operating_sub_phase: "Track",
      active_player_index: real.player_addresses.indexOf(C),
      market_positions: { ...real.market_positions, [co.company_id]: { price: 67, ...marketCellForPrice(67)!, enteredAt: 3 } },
      public_companies: real.public_companies.map((company) =>
        company.company_id === co.company_id
          ? {
              ...company,
              is_floated: true,
              president: C,
              par_value: "67",
              treasury: "670",
              owned_trains: ["2"],
              last_route_revenue: "0",
              player_holdings: [{ player: C, percentage: 60 }],
              ipo_pool_percentage: 40,
              home_hex_label: "I5",
              station_token_hexes: [[hex("I5").q, hex("I5").r]],
              station_tokens: [[hex("I5").q, hex("I5").r, 0]],
            }
          : company,
      ),
    } as unknown as State;
    return { start: { state, waterfall: state.waterfall ?? null }, providers: YS.roomProviders(state, YS.GULF) };
  }

  /** The C&O's turn: to Routes, the Gulf run, the dividend (paid out or withheld), End Turn. */
  function coTurn(game: Game, distribute: boolean) {
    for (let guard = 0; stepOf(game) !== "Routes"; guard += 1) {
      if (guard > 4) throw new Error("the C&O did not reach Routes");
      game.play(C, ADVANCE(game.state, "C&O"));
    }
    game.refuse(C, ADVANCE(game.state, "C&O")); // a paying route may not be skipped (§6.4)
    const bankBeforeRun = Number(game.state.virtual_bank_vgp);
    game.play(C, YS.runMsg(companyOf(game.state, "C&O").company_id, [YS.TWO_ROUTE], [0], ["2"]));
    const earned = Number(companyOf(game.state, "C&O").last_route_revenue);
    const bankAfterRun = Number(game.state.virtual_bank_vgp);
    expect(earned).toBeGreaterThan(0);
    for (let guard = 0; stepOf(game) !== "Dividends"; guard += 1) {
      if (guard > 2) throw new Error("the C&O did not reach Dividends");
      game.play(C, ADVANCE(game.state, "C&O"));
    }
    game.play(C, { DeclareDividends: { game_id: 0, protocol_id: companyOf(game.state, "C&O").company_id, revenue_amount: String(earned), distribute } });
    const bankAfterDividend = Number(game.state.virtual_bank_vgp);
    expect(bankAfterRun).toBe(bankBeforeRun); // the run records the revenue; the dividend step pays it
    return { earned, bankBeforeRun, bankAfterRun, bankAfterDividend };
  }

  let game: Game;
  let eve: ReturnType<typeof breakEve>;
  beforeAll(() => {
    eve = breakEve();
    game = new Game(newRoom(eve.start, eve.providers), eve.start, eve.providers);
    game.bank = money(eve.start.state);
    expect([tier(eve.start.state), eve.start.state.private_auction_complete, bankIsBroken(eve.start.state)]).toEqual(["3", false, false]);
    const paid = coTurn(game, true); // $50 run; the distributed dividend (C's 60%: $30) takes the $20 bank past zero
    expect([paid.earned, paid.bankBeforeRun, paid.bankAfterDividend]).toEqual([50, 20, -10]);
    game.mark("T11.broken");
    expect(bankIsBroken(game.state)).toBe(true);
    expect(game.state.bank_broken).toBe(true);
    expect([game.state.current_round_type, operating(game.state)?.ticker]).toEqual(["OperatingRound", "C&O"]); // mid-set: nothing ends yet
    game.play(C, PASS_TURN);
    expect(operating(game.state)?.ticker).toBe("PRR"); // THE SET FINISHES: the PRR still takes its turn (#898)
    game.mark("T11.prr-turn");
    orTurn(game, 1); // the PRR's 3-train fills its fleet; the room ends the turn; the set is over
    game.mark("T11.ended");
  });

  it("the set's end is the game's end -- GameEnd, not the auction; the owed auction was never armed and never ran", () => {
    const board = game.state;
    expect(board.current_round_type).toBe("GameEnd");
    expect(board.macro_round_number).toBe(eve.start.state.macro_round_number); // no macro-round was opened for an auction
    expect(board.waterfall?.waterfall_auction_active).toBe(false);
    expect(board.waterfall?.privates).toHaveLength(6);
    expect(board.private_auction_complete).toBe(false);
    expect(board.private_companies.map((entry) => [entry.private_id, entry.owner ?? null, !!entry.closed])).toEqual(
      [SV, CS, DH, MH, CA, BO].map((id) => [id, null, false]),
    );
    expect(companyOf(board, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 }); // still in the IPO, counted
    expectConserved(board, "GameEnd");
  });

  it("nothing re-enters play at GameEnd: every auction message, the handoff, a round transition, a turn -- refused; undo refused too", () => {
    for (const player of [A, B, C]) {
      game.refuse(player, WF_BUY);
      game.refuse(player, WF_BID(DH, 75));
      game.refuse(player, WF_PASS);
      game.refuse(player, OPEN);
      game.refuse(player, BEGIN_OR);
      game.refuse(player, PASS_TURN);
      game.refuse(player, BUY_STOCK(game.state, "NYC"));
    }
    const last = [...effectiveActions(game.room.entries)].reverse().find((entry) => !entry.derived)!;
    game.refuse(A, REVERT(last.index, A), REVERT_GAME_ENDED); // RV-3: the ending is final for the room
  });

  it("the settlement reads the ended board as it stands: no seat is credited an unsold private", () => {
    const seats = game.state.player_addresses.map((player_id, seat_index) => ({ seat_index, player_id }));
    /* ESCROW-3A: the game plays v11 and settlement is now certified for v11 as well (DA-8 had refused it until the
       recertification) -- so the v11 Delayed Auction board, dealt and played to GameEnd by the v11 reducer, is appraised
       AS IT STANDS: its certificates conserve (DA-F6's mint, SET-0A F-7, is closed at v11), and it appraises exactly as
       the same board at the v10 pin. The rule under test (an unsold private is nobody's) is the appraiser's. */
    expect(game.state.rules_engine_version).toBe(RULES_ENGINE_VERSION);
    const appraisal = appraiseSeats(game.state, seats);
    expect(appraisal).toEqual(appraiseSeats({ ...game.state, rules_engine_version: 10 } as State, seats));
    for (const seat of appraisal) {
      expect([seat.player_id, seat.privates, seat.bankrupt]).toEqual([seat.player_id, BigInt(0), false]);
      expect(seat.total).toBe(seat.cash_counted + seat.shares);
    }
  });

  it("live == replay == restore at the break, on the PRR's closing turn, and at GameEnd", () => {
    for (const label of ["T11.broken", "T11.prr-turn", "T11.ended"]) expectRebuildsAt(game.at(label), label, eve.start, eve.providers);
  });

  it("undo inside the broken set keeps the break and the ending due; redone, the same board", () => {
    const alt = new Game(restoredAt(game.at("T11.prr-turn"), eve.start, eve.providers), eve.start, eve.providers);
    const endTurn = [...effectiveActions(alt.room.entries)].reverse().find((entry) => !entry.derived)!;
    expect(kindOf(endTurn)).toBe("PassTurn");
    alt.play(A, REVERT(endTurn.index, A));
    expect([operating(alt.state)?.ticker, bankIsBroken(alt.state), alt.state.current_round_type]).toEqual(["C&O", true, "OperatingRound"]);
    alt.play(C, PASS_TURN);
    expect(stateDigest(alt.state)).toBe(game.at("T11.prr-turn").digest);
    orTurn(alt, 1);
    expect(stateDigest(alt.state)).toBe(game.at("T11.ended").digest);
  });

  it("the ending is the break's alone: the same set, the same run and the same messages with a solvent bank end in the auction, on the Priority Deal holder", () => {
    /* The C&O's revenue is the bank's to pay whether it is distributed or withheld (1830 §6.5) and a paying route may not
       be skipped (§6.4), so no legal play in this set avoids the break with $20 in the bank -- withholding breaks it too
       (the whole $50 to the treasury). The control is therefore the same board with a solvent bank. */
    const withheld = breakEve(20);
    const w = new Game(newRoom(withheld.start, withheld.providers), withheld.start, withheld.providers);
    expect(coTurn(w, false).bankAfterDividend).toBe(-30);
    expect(bankIsBroken(w.state)).toBe(true);
    const solvent = breakEve(5_000);
    const control = new Game(newRoom(solvent.start, solvent.providers), solvent.start, solvent.providers);
    control.bank = money(solvent.start.state);
    coTurn(control, true);
    expect(bankIsBroken(control.state)).toBe(false);
    control.play(C, PASS_TURN);
    orTurn(control, 1);
    expect([control.state.current_round_type, control.state.macro_round_number]).toEqual(["WaterfallAuction", eve.start.state.macro_round_number + 1]);
    expect(control.state.waterfall?.waterfall_auction_active).toBe(true);
    expect(actorOf(control.state)).toBe(holderOf(eve.start.state));
    // Entry for entry the same log up to the set's end -- only the board's bank differed.
    expect(control.room.entries.map(kindOf)).toEqual(game.room.entries.map(kindOf));
  });

  it("a bank already broken when the trigger set opens ends the game at that set's end the same way (the break's timing is not recorded, #898)", () => {
    const early = breakEve(-5); // broken before the set: the balance itself is past zero
    expect(bankIsBroken(early.start.state)).toBe(true);
    const g = new Game(newRoom(early.start, early.providers), early.start, early.providers);
    coTurn(g, false);
    g.play(C, PASS_TURN);
    orTurn(g, 1);
    expect(g.state.current_round_type).toBe("GameEnd");
    expect(g.state.waterfall?.waterfall_auction_active).toBe(false);
    expect(g.state.private_auction_complete).toBe(false);
  });
});
