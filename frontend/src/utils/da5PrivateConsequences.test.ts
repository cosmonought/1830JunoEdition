/** @jest-environment node */
//
// ==================================================================
//  DA-5: WHAT THE PRIVATE COMPANIES DO TO THE BOARD UNDER THE DELAYED AUCTION (Delayed Auction certification)
// ==================================================================
//
// `VARIANT_CERT_DELAYED_AUCTION_AUDIT_2026-09-25.md` DA-F6 and DA-F9, and owner rulings D-52..D-59:
//   D-52   one specific ordinary 10% PRR certificate is reserved from the deal for the C&A's first purchaser: not
//          for ordinary sale, still in total supply, transferred -- never minted -- by the purchase, released when
//          Phase 5 closes the C&A unsold (probe Q2: PRR at 110%).
//   DA-F6  the grant runs a share's ordinary consequences AT ONCE: presidency (§5.4 "immediately") and float
//          (probe Q3: a grantee holding more than the president did not take the chair; PRR at 60% sold unfloated).
//   D-57/D-58/D-59  no voluntary acquisition (face-value purchase, initial or increased bid, contest raise) may leave
//          an excess over the certificate limit or a 60% cap that no legal sale in the next Stock Round could cure;
//          other standing bids count as won; awards of legal bids and the forced $0 SV are honoured; the must-sell
//          hold owes only the curable part, so an incurable excess never deadlocks the game.
//   D-55 / DA-F9  the first 5-train before a pending Delayed Auction closes the unsold privates and CANCELS the
//          auction for good: no arming, the reserved certificate back in supply, the B&O unlocked, nothing closed
//          offered, and the following Stock Round opened the ordinary way on the Priority Deal holder -- not on the
//          auction's dormant cursor (DA-4's pointer belongs to an auction that ran). DA-F12 is DA-8's, not this file's.
// Every message goes through BOTH locks (ingress, then the room engine), and after every applied message every
// corporation's certificates are counted: holdings + IPO + Bank Pool = 100%, the reserved certificate inside the IPO.

export {};

type State = import("../gameEngine/gameState").GameStateResponse;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;

const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { applyPhaseChange, operatingRoundSequenceLength } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { actingAddress, certificateBreakdown } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { ordinaryPercentAvailable } =
  require("../gameEngine/stockTransactionAuthority") as typeof import("../gameEngine/stockTransactionAuthority");
const { assessExcess, chartForDivestment, divestmentDebt, divestmentPassRefusal, incurableExcess } =
  require("../gameEngine/forcedDivestment") as typeof import("../gameEngine/forcedDivestment");
const { acquisitionSolvencyRefusal } = require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");
const { boIsLocked, resolveVariants } = require("../gameEngine/gameVariants") as typeof import("../gameEngine/gameVariants");
const { marketCellForPrice, marketZoneForPrice } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");
const { RoomSession } = require("./roomSession") as typeof import("./roomSession");

const A = "p-da5-a01";
const B = "p-da5-b02";
const C = "p-da5-c03";
const SV = 1;
const CS = 2;
const DH = 3;
const MH = 4;
const CA = 5;
const BO = 6;
const BUILD = "b-da5";

const SETUP = (delayed: boolean) => ({
  SetupGame: {
    players: [
      { id: A, nickname: "A" },
      { id: B, nickname: "B" },
      { id: C, nickname: "C" },
    ],
    variants: { delayedAuction: delayed, length: "standard", rules: 1 },
    rules_engine_version: RULES_ENGINE_VERSION,
  },
});
const BUY = { WaterfallBuyLowest: { game_id: 0 } };
const PASS = { WaterfallPass: { game_id: 0 } };
const MINI_PASS = { WaterfallMiniAuctionPass: { game_id: 0 } };
const RAISE = (amount: number) => ({ WaterfallMiniAuctionRaise: { game_id: 0, bid_amount: String(amount) } });
const BID = (privateId: number, amount: number) => ({
  WaterfallBidHigher: { game_id: 0, private_id: privateId, bid_amount: String(amount) },
});
const OPEN = { OpenStockRound: {} };
const PAR = (player: string) => ({ SetBoPar: { player, par_value: "100" } });
const PASS_TURN = { PassTurn: { game_id: 0 } };

const companyOf = (board: State, ticker: string) => board.public_companies.find((company) => company.ticker === ticker)!;
const heldBy = (board: State, ticker: string, player: string) =>
  companyOf(board, ticker).player_holdings.find((entry) => entry.player === player)?.percentage ?? 0;
const SHARE = (board: State, ticker: string, par?: number) => ({
  BuyStock: {
    game_id: 0,
    protocol_id: companyOf(board, ticker).company_id,
    source: "Ipo",
    ...(par === undefined ? {} : { par_value: String(par) }),
  },
});
const SELL = (board: State, ticker: string, percentage: number) => ({
  SellStock: { game_id: 0, protocol_id: companyOf(board, ticker).company_id, percentage },
});
const TRAIN = (board: State, ticker: string, model: string) => ({
  BuyHardwareFromPool: { game_id: board.game_id ?? 0, protocol_id: companyOf(board, ticker).company_id, model_type: model },
});

const seed = () => ({
  state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
  waterfall: waterfallForRoster(SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
});
const seedBoard = (): State => {
  const start = seed();
  return { ...start.state, waterfall: start.waterfall } as State;
};

let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `da5-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];

/** A room's chart is seeded from its providers' `initialMarket`, not from the board (#1197) -- so a hand-built board's
 *  own chart travels with it, or the room would re-derive every position (the GR-4 harness's `roomProviders`). A
 *  replay or restore of the same log is handed the same providers. */
const providersFor = (board: State) => ({
  ...sandboxReplayProviders(),
  ...(board.market_positions ? { initialMarket: board.market_positions } : {}),
});
const engineFrom = (board: State): Engine =>
  new RL.RoomEngine(providersFor(board) as never, { state: board, waterfall: board.waterfall ?? null } as never);
const boardOf = (engine: Engine): State =>
  ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const seatOf = (board: State) => board.player_addresses[board.active_player_index];
const holderOf = (board: State) => board.player_addresses[board.priority_deal_index];
const actorOf = (board: State) => actingAddress(board, board.waterfall ?? null) as string;
const cursorOf = (board: State) => board.waterfall?.current_turn ?? null;
const ownerOf = (board: State, id: number) =>
  board.private_companies.find((entry) => entry.private_id === id)?.owner ?? null;
const refusalOf = (board: State, actor: string, msg: unknown) =>
  turnRefusal({ state: board, waterfall: board.waterfall ?? null, actor, msg: msg as never });
const countOf = (board: State, player: string) => {
  const chart = chartForDivestment(board);
  return certificateBreakdown(player, board, chart.marketPrices, chart.zoneForPrice as never).counted;
};
const excessOf = (board: State, player: string) =>
  assessExcess({ state: { ...board, current_round_type: "StockRound" }, player, ...chartForDivestment(board) });
const money = (board: State) =>
  Number(board.virtual_bank_vgp) +
  board.player_cash.reduce((sum, entry) => sum + Number(entry.cash_vgp), 0) +
  board.public_companies.reduce((sum, company) => sum + Number(company.treasury ?? 0), 0) +
  (board.waterfall?.privates ?? []).reduce(
    (sum, offered) => sum + offered.bids.reduce((inner, bid) => inner + Number(bid.bid_amount ?? 0), 0),
    0,
  );

/** THE SETTLEMENT-INTEGRITY CONTROL: every corporation's certificates add to 100% -- holdings + IPO + Bank Pool -- and a
 *  reserved certificate is one the IPO actually holds. Asked after every message this file applies. */
function expectConserved(board: State, where: string) {
  for (const company of board.public_companies) {
    const held = company.player_holdings.reduce((sum, holding) => sum + holding.percentage, 0);
    const reserved = company.reserved_certificate?.percentage ?? 0;
    expect([where, company.ticker, held + company.ipo_pool_percentage + company.bank_pool_percentage]).toEqual([
      where,
      company.ticker,
      100,
    ]);
    expect([where, company.ticker, reserved <= company.ipo_pool_percentage]).toEqual([where, company.ticker, true]);
  }
}

/** Sends one message as `actor` through BOTH locks: ingress must accept it and the room engine applies it. */
function send(engine: Engine, actor: string, msg: unknown) {
  const board = boardOf(engine);
  const kind = Object.keys(msg as object)[0];
  expect([kind, refusalOf(board, actor, msg)]).toEqual([kind, null]);
  engine.apply(entry(actor, msg));
  expectConserved(boardOf(engine), kind);
}

/** Both locks refuse: ingress gives the reason, and the reducer -- run by a room, with the chart its providers inject,
 *  as the server runs it -- leaves the board exactly as it was. */
function expectRefused(board: State, actor: string, msg: unknown): string {
  const reason = refusalOf(board, actor, msg);
  expect(reason).not.toBeNull();
  const room = engineFrom(board);
  const before = stateDigest(boardOf(room));
  room.apply(entry(actor, msg));
  expect(stateDigest(boardOf(room))).toBe(before);
  return reason as string;
}

type Step = "buy" | "pass" | "mini-pass" | [number, number];
/** Plays auction steps for whoever the auction is waiting on. */
function play(engine: Engine, steps: readonly Step[]): string[] {
  const actors: string[] = [];
  for (const step of steps) {
    const actor = actorOf(boardOf(engine));
    actors.push(actor);
    send(engine, actor, step === "buy" ? BUY : step === "pass" ? PASS : step === "mini-pass" ? MINI_PASS : BID(step[0], step[1]));
  }
  return actors;
}

/* ---- Stock Rounds ------------------------------------------------------------------------------ */

/** One Stock Round turn for the seat: declines to sell (#1443), buys one certificate, ends the turn. */
function stockBuy(engine: Engine, ticker: string, par?: number): string {
  const player = seatOf(boardOf(engine));
  send(engine, player, PASS_TURN);
  send(engine, player, SHARE(boardOf(engine), ticker, par));
  send(engine, player, PASS_TURN);
  return player;
}

/** The seat passes its turn. */
function stockPass(engine: Engine): string {
  const start = boardOf(engine);
  const player = seatOf(start);
  for (let n = 0; n < 2; n += 1) {
    const now = boardOf(engine);
    if (now.current_round_type !== "StockRound" || now.macro_round_number !== start.macro_round_number) break;
    if (seatOf(now) !== player) break;
    send(engine, player, PASS_TURN);
  }
  return player;
}

function finishStockRound(engine: Engine): State {
  const start = boardOf(engine).macro_round_number;
  for (let guard = 0; ; guard += 1) {
    const now = boardOf(engine);
    if (now.current_round_type !== "StockRound" || now.macro_round_number !== start) return now;
    if (guard > 12) throw new Error("the Stock Round did not end");
    stockPass(engine);
  }
}

/* ---- the games ---------------------------------------------------------------------------------- */

function dealt(delayed: boolean): Engine {
  const engine = engineFrom(seedBoard());
  engine.apply(entry(A, SETUP(delayed)));
  return engine;
}

/** A REAL Stock Round 1 of the Delayed Auction, one item per turn in seat order from the holder (A): a corporation to
 *  buy (a par starts it) or a pass; then passes until the round ends. */
function delayedStockRound1(script: ReadonlyArray<[string, number?] | "pass">): State {
  const engine = dealt(true);
  for (const turn of script) {
    if (turn === "pass") stockPass(engine);
    else stockBuy(engine, turn[0], turn[1]);
  }
  const after = finishStockRound(engine);
  expect(after.current_round_type).toBe("StockRound"); // nothing floated: the Operating Round was skipped
  expect(after.macro_round_number).toBe(2);
  return after;
}

/** The end of the Operating Round set in which the first 3-train was bought -- HAND-BUILT on a real board, as DA-4's
 *  harness does: the NYC floated under C (the last operating president), trains 2 + 3, the set's last OR at its end.
 *  `edit` shapes the rest of the board (a hand-placed position for the case at hand). */
function operatingRoundEnd(real: State, edit: (company: State["public_companies"][number]) => object = () => ({})): State {
  const nyc = companyOf(real, "NYC");
  return {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(C),
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? {
            ...company,
            is_floated: true,
            president: C,
            par_value: "100",
            owned_trains: ["2", "3"],
            player_holdings: [{ player: C, percentage: 60 }],
            ipo_pool_percentage: 40,
            station_token_hexes: ["G19"],
          }
        : { ...company, ...edit(company) },
    ),
  } as State;
}

/** The set ends through the room engine: the Delayed Auction is inserted and armed by the reducer's own transition. */
function armed(orEnd: State): Engine {
  const engine = engineFrom(orEnd);
  send(engine, C, PASS_TURN);
  const board = boardOf(engine);
  expect(board.current_round_type).toBe("WaterfallAuction");
  expect(board.waterfall?.waterfall_auction_active).toBe(true);
  return engine;
}

/** DA-4's game: A started the PRR at 100 in a real Stock Round 1, so the Priority Deal holder -- the auction's opener -- is B. */
const DA4_STOCK_ROUND = (): State => delayedStockRound1([["PRR", 100]]);

/* ================================================================================================== */
describe("D-52 / DA-F6: the C&A's PRR certificate", () => {
  it("1. the reservation exists only under the Delayed Auction -- one ordinary 10% of the PRR, still in the IPO", () => {
    const delayed = boardOf(dealt(true));
    const standard = boardOf(dealt(false));
    expect(companyOf(delayed, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(delayed.public_companies.filter((company) => company.reserved_certificate).map((company) => company.ticker)).toEqual(["PRR"]);
    expect(companyOf(delayed, "PRR").ipo_pool_percentage).toBe(100); // the bank still owns it: it counts as unsold
    expect(ordinaryPercentAvailable(companyOf(delayed, "PRR"), "Ipo")).toBe(70); // 100 - the President's 20 - the reserved 10
    // THE STANDARD GAME RESERVES NOTHING and no standard IPO share is withheld.
    expect(standard.public_companies.filter((company) => company.reserved_certificate)).toEqual([]);
    expect(ordinaryPercentAvailable(companyOf(standard, "PRR"), "Ipo")).toBe(80);
    expectConserved(delayed, "deal");
  });

  it("2. ordinary purchases stop at the reserved certificate: 90% sold, and the last 10% in the IPO is not for sale", () => {
    const engine = dealt(true);
    // A starts the PRR; the table then buys it round and round: 20 + 7 x 10 = 90%.
    stockBuy(engine, "PRR", 67);
    for (let n = 0; n < 7; n += 1) stockBuy(engine, "PRR");
    const board = boardOf(engine);
    const prr = companyOf(board, "PRR");
    expect(prr.player_holdings.reduce((sum, holding) => sum + holding.percentage, 0)).toBe(90);
    expect(prr.ipo_pool_percentage).toBe(10);
    expect(prr.reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(ordinaryPercentAvailable(prr, "Ipo")).toBe(0);
    expect(prr.is_floated).toBe(true); // 60% out of the IPO -- the reserved certificate is not one of them
    const buyer = seatOf(board);
    send(engine, buyer, PASS_TURN); // Sell -> Buy
    expectRefused(boardOf(engine), buyer, SHARE(boardOf(engine), "PRR"));
  });

  it("3. the C&A's purchaser receives exactly the reserved certificate: the IPO's last 10%, nothing minted", () => {
    // Hand-placed on DA-4's real board: the PRR 90% sold (A presides at 50, C 40), the reserved 10% the IPO's last.
    const orEnd = operatingRoundEnd(DA4_STOCK_ROUND(), (company) =>
      company.ticker === "PRR"
        ? { is_floated: true, treasury: "1000", president: A, ipo_pool_percentage: 10, player_holdings: [{ player: A, percentage: 50 }, { player: C, percentage: 40 }] }
        : {},
    );
    const engine = armed(orEnd);
    expect(actorOf(boardOf(engine))).toBe(B);
    play(engine, ["buy", "buy", "buy", "buy"]); // B SV, C C&SL, A D&H, B M&H
    const before = boardOf(engine);
    const prrBefore = companyOf(before, "PRR");
    // D-52's identity before the grant: holdings + available IPO + pool + reserved = 100%.
    const held = (board: State) => companyOf(board, "PRR").player_holdings.reduce((sum, holding) => sum + holding.percentage, 0);
    expect(held(before) + ordinaryPercentAvailable(prrBefore, "Ipo") + prrBefore.bank_pool_percentage + 10).toBe(100);
    expect(actorOf(before)).toBe(C);
    play(engine, ["buy"]); // C buys the C&A
    const after = boardOf(engine);
    const prrAfter = companyOf(after, "PRR");
    expect(ownerOf(after, CA)).toBe(C);
    expect(heldBy(after, "PRR", C)).toBe(50); // + exactly 10
    expect(prrAfter.ipo_pool_percentage).toBe(0); // the reserved certificate, and only it, left the IPO
    expect(prrAfter.bank_pool_percentage).toBe(prrBefore.bank_pool_percentage);
    expect(prrAfter.reserved_certificate ?? null).toBeNull();
    // ...and after it: holdings + IPO + pool = 100%, with nothing reserved.
    expect(held(after) + prrAfter.ipo_pool_percentage + prrAfter.bank_pool_percentage).toBe(100);
    expect(prrAfter.president).toBe(A); // a 50-50 tie leaves the chair where it is
  });

  it("4. the PRR stays at 100% through the deal, Stock Round 1, the auction and the grant -- the reserve counted inside the IPO", () => {
    const sr2 = delayedStockRound1([["PRR", 67], ["PRR"], ["PRR"]]); // A 20, B 10, C 10
    expectConserved(sr2, "Stock Round 1");
    const engine = armed(operatingRoundEnd(sr2));
    const prr = () => companyOf(boardOf(engine), "PRR");
    const reservedTrail: Array<number | null> = [];
    for (let n = 0; n < 6; n += 1) {
      play(engine, ["buy"]); // every message: conservation asserted by `send`
      reservedTrail.push(prr().reserved_certificate?.percentage ?? null);
    }
    const closed = boardOf(engine);
    const buyer = ownerOf(closed, CA) as string;
    expect(reservedTrail).toEqual([10, 10, 10, 10, null, null]); // lifted by the C&A, the fifth purchase
    expect(prr().ipo_pool_percentage).toBe(50); // 60 unsold before the grant, one certificate less after
    expect(heldBy(closed, "PRR", buyer)).toBeGreaterThanOrEqual(10);
  });

  it("5. a grant that gives its holder more than the president settles the presidency at once", () => {
    // A starts the PRR at 20%; B buys twice (20%). C holds the Priority Deal after Stock Round 1 and opens the auction.
    const sr2 = delayedStockRound1([["PRR", 67], ["PRR"], "pass", "pass", ["PRR"]]);
    expect(heldBy(sr2, "PRR", A)).toBe(20);
    expect(heldBy(sr2, "PRR", B)).toBe(20);
    expect(companyOf(sr2, "PRR").president).toBe(A);
    const engine = armed(operatingRoundEnd(sr2));
    expect(actorOf(boardOf(engine))).toBe(C);
    // C SV, A C&SL, B bids on the C&A, C D&H; A's M&H purchase leaves the C&A lowest and the cascade awards it to B.
    play(engine, ["buy", "buy", [CA, 165], "buy"]);
    expect(companyOf(boardOf(engine), "PRR").president).toBe(A);
    play(engine, ["buy"]);
    const after = boardOf(engine);
    expect(ownerOf(after, CA)).toBe(B);
    // Probe Q3: B held 30% to A's 20% and A kept the chair until somebody's next share trade.
    expect(heldBy(after, "PRR", B)).toBe(30);
    expect(heldBy(after, "PRR", A)).toBe(20);
    expect(companyOf(after, "PRR").president).toBe(B);
  });

  it("6. a grant that brings the PRR to 60% sold floats it at once, with its full capital from the bank", () => {
    // A 30, B 10, C 10: 50% sold -- unfloated. B holds the Priority Deal and opens the auction.
    const sr2 = delayedStockRound1([["PRR", 67], ["PRR"], ["PRR"], ["PRR"]]);
    expect(companyOf(sr2, "PRR").is_floated).toBeFalsy();
    const engine = armed(operatingRoundEnd(sr2));
    expect(actorOf(boardOf(engine))).toBe(B);
    play(engine, ["buy", "buy", "buy", "buy"]); // B SV, C C&SL, A D&H, B M&H
    const before = boardOf(engine);
    const bankBefore = Number(before.virtual_bank_vgp);
    expect(actorOf(before)).toBe(C);
    play(engine, ["buy"]); // C buys the C&A: 60% sold
    const after = boardOf(engine);
    const prr = companyOf(after, "PRR");
    expect(ownerOf(after, CA)).toBe(C);
    expect(100 - prr.ipo_pool_percentage).toBe(60);
    // Probe Q2/Q3: the PRR entered the Operating Round unfloated.
    expect(prr.is_floated).toBe(true);
    expect(Number(prr.treasury)).toBe(670); // 10 x its $67 par
    expect(Number(after.virtual_bank_vgp)).toBe(bankBefore + 160 - 670); // the C&A's price in, the capital out
    expect(money(after)).toBe(money(before)); // nothing created, nothing lost
  });

  it("7. the standard C&A is unchanged: one 10% of the unstarted PRR from its IPO, no presidency, no float, nothing reserved", () => {
    const engine = dealt(false);
    const prr = () => companyOf(boardOf(engine), "PRR");
    expect(ordinaryPercentAvailable(prr(), "Ipo")).toBe(80);
    const buyers = play(engine, ["buy", "buy", "buy", "buy", "buy"]); // A SV, B C&SL, C D&H, A M&H, B C&A
    const after = boardOf(engine);
    expect(ownerOf(after, CA)).toBe(buyers[4]);
    expect(heldBy(after, "PRR", buyers[4])).toBe(10);
    expect(prr().ipo_pool_percentage).toBe(90);
    expect(prr().bank_pool_percentage).toBe(0);
    expect(prr().president).toBeNull();
    expect(prr().is_floated).toBeFalsy();
    expect(prr().reserved_certificate ?? null).toBeNull();
    expect(ordinaryPercentAvailable(prr(), "Ipo")).toBe(70);
  });

  it("8. restore, replay and RevertTo rebuild the reservation, the grant and its presidency from the log alone", () => {
    const orEnd = operatingRoundEnd(delayedStockRound1([["PRR", 67], ["PRR"], "pass", "pass", ["PRR"]]));
    let n = 0;
    const room = new RoomSession({
      providers: providersFor(orEnd) as never,
      seed: { state: orEnd, waterfall: orEnd.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `r${(n += 1)}`,
    });
    const submit = (actor: string, msg: unknown) =>
      room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
    const next = () => actingAddress(room.state, room.state.waterfall ?? null) as string;
    expect(submit(C, PASS_TURN).kind).toBe("applied");
    for (const msg of [BUY, BUY, BID(CA, 165), BUY]) expect(submit(next(), msg).kind).toBe("applied");
    const awardIndex = room.nextIndex;
    expect(submit(next(), BUY).kind).toBe("applied"); // A's M&H: the cascade awards the C&A to B
    const granted = room.state;
    expect(companyOf(granted, "PRR").president).toBe(B);
    expect(companyOf(granted, "PRR").reserved_certificate ?? null).toBeNull();
    // Back behind the award: the certificate is reserved again, B's bid stands, A presides.
    expect(submit(A, { RevertTo: { index: awardIndex, player: A, summary: "the M&H" } }).kind).toBe("applied");
    expect(companyOf(room.state, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(companyOf(room.state, "PRR").president).toBe(A);
    expect(heldBy(room.state, "PRR", B)).toBe(20);
    expect(ownerOf(room.state, CA)).toBeNull();
    expectConserved(room.state, "reverted");
    // Forward again: the same board as the first time.
    expect(submit(next(), BUY).kind).toBe("applied");
    expect(stateDigest(room.state)).toBe(stateDigest(granted));
    // A room restored from the stored entries, a replay of them, and the reducer applied message by message agree.
    let m = 0;
    const restored = new RoomSession({
      providers: providersFor(orEnd) as never,
      seed: { state: orEnd, waterfall: orEnd.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `q${(m += 1)}`,
    });
    restored.restore(room.entries as never);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
    const replayed = RL.replayLog(room.entries as never, providersFor(orEnd) as never, {
      state: orEnd,
      waterfall: orEnd.waterfall ?? null,
    } as never).state as State;
    expect(stateDigest(replayed)).toBe(stateDigest(room.state));
  });
});

/* ================================================================================================== */
/* THE LIMIT BOARDS. DA-4's armed auction (B opens it), with B hand-placed at the certificate limit: B presides over five
   corporations in the Normal zone (counted), each 50% his -- four certificates apiece -- and 50% in the Bank Pool, which
   is full, so no share of them can be sold. `cards: 19` leaves the NNH at 40% (three certificates); `roomIn` leaves one
   corporation's pool at 40%, so one 10% sale is legal there. ON REAL CHART CELLS, ONE CORPORATION A CELL (the GR-4
   harness's rule): a room re-derives a position its chart does not hold, and a corporation with no chart price may not
   be sold on a pinned board -- which would make every excess here incurable for the wrong reason. */
const LIMIT_CORPS = ["CPR", "C&O", "ERIE", "B&M", "NNH"];
const LIMIT_PRICES = [67, 69, 71, 76, 82];
function limitBoard(opts: { cards: 19 | 20; roomIn?: string }): State {
  const board = boardOf(armed(operatingRoundEnd(DA4_STOCK_ROUND())));
  let enteredAt = 100;
  const positions: Record<number, unknown> = { ...(board.market_positions ?? {}) };
  /* The NYC (C's) is marked down into the Yellow zone: a purchase of it counts toward no limit, so only the must-sell
     hold can refuse it -- the one purchase that shows the hold itself (test 17). */
  const nyc = companyOf(board, "NYC").company_id;
  expect(marketZoneForPrice(60)).toBe("Yellow");
  positions[nyc] = { price: 60, ...marketCellForPrice(60)!, enteredAt: (enteredAt += 1) };
  const companies = board.public_companies.map((company) => {
    const at = LIMIT_CORPS.indexOf(company.ticker);
    if (at < 0) return company;
    const price = LIMIT_PRICES[at];
    expect(marketZoneForPrice(price)).toBe("Normal");
    positions[company.company_id] = { price, ...marketCellForPrice(price)!, enteredAt: (enteredAt += 1) };
    const held = opts.cards === 19 && company.ticker === "NNH" ? 40 : 50;
    const pool = opts.roomIn === company.ticker ? 40 : 50;
    return {
      ...company,
      is_floated: true,
      par_value: String(price),
      treasury: String(price * 10),
      president: B,
      player_holdings: [{ player: B, percentage: held }],
      bank_pool_percentage: pool,
      ipo_pool_percentage: 100 - held - pool,
    };
  });
  const limited = { ...board, public_companies: companies, market_positions: positions } as State;
  expect(actorOf(limited)).toBe(B);
  expect(countOf(limited, B)).toBe(opts.cards);
  // The room holds every position as placed -- the boards below are judged on the chart they show.
  expect(boardOf(engineFrom(limited)).market_positions).toEqual(limited.market_positions);
  return limited;
}

/** After the auction the B&O's owner pars it and hands off; returns the Stock Round it opens. */
function handOff(engine: Engine): State {
  const closed = boardOf(engine);
  expect(closed.waterfall?.privates).toHaveLength(0);
  const owner = ownerOf(closed, BO) as string;
  send(engine, owner, PAR(owner));
  send(engine, owner, OPEN);
  const sr = boardOf(engine);
  expect(sr.current_round_type).toBe("StockRound");
  return sr;
}

describe("D-57 / D-58 / D-59: no voluntary acquisition may leave an excess the next Stock Round cannot cure", () => {
  it("9. a face-value purchase is refused when it would put the buyer over the limit with nothing he could sell -- and allowed when it would not", () => {
    const full = limitBoard({ cards: 20 });
    const reason = expectRefused(full, B, BUY);
    expect(reason).toContain("1 certificate over the limit");
    expect(reason).toContain("no legal sale in the next Stock Round could bring you back");
    // Controls: one certificate under the limit; or a corporation whose pool can take a sale (curable, so allowed).
    const under = engineFrom(limitBoard({ cards: 19 }));
    send(under, B, BUY);
    expect(countOf(boardOf(under), B)).toBe(20);
    const curable = engineFrom(limitBoard({ cards: 20, roomIn: "NNH" }));
    send(curable, B, BUY);
    expect(countOf(boardOf(curable), B)).toBe(21);
    // The rulings are the Delayed Auction's: the same position under the standard rules is not judged here.
    expect(acquisitionSolvencyRefusal({ ...full, variants: { ...full.variants, delayedAuction: false } }, full.waterfall ?? null, B, SV)).toBeNull();
  });

  it("10. an initial bid is refused for the same reason", () => {
    const reason = expectRefused(limitBoard({ cards: 20 }), B, BID(CS, 45));
    expect(reason).toContain("1 certificate over the limit");
    const under = engineFrom(limitBoard({ cards: 19 }));
    send(under, B, BID(CS, 45));
  });

  it("11. a contest raise is refused once an involuntary event has used the room its bid was placed in -- and the standing bid is kept", () => {
    const engine = engineFrom(limitBoard({ cards: 19 }));
    send(engine, B, BID(DH, 75)); // 20 with it: legal when placed
    send(engine, C, BID(DH, 80));
    send(engine, A, BID(CS, 45));
    play(engine, Array(12).fill("pass")); // four laps from B: the SV reaches $0 and B must take it (mandatory)
    let board = boardOf(engine);
    expect(ownerOf(board, SV)).toBe(B);
    expect(ownerOf(board, CS)).toBe(A); // a lone bid, awarded in the cascade
    expect(board.waterfall?.mini_auction?.private_id).toBe(DH);
    if (actorOf(board) === C) {
      send(engine, C, RAISE(85));
      board = boardOf(engine);
    }
    expect(actorOf(board)).toBe(B);
    const reason = expectRefused(board, B, RAISE(90));
    expect(reason).toContain("1 certificate over the limit");
    send(engine, B, MINI_PASS);
    expect(ownerOf(boardOf(engine), DH)).toBe(C);
  });

  it("12. bid admission counts the bidder's other standing bids as won", () => {
    const engine = engineFrom(limitBoard({ cards: 19 }));
    send(engine, B, BID(CS, 45)); // 20 with it: legal
    send(engine, C, PASS);
    send(engine, A, PASS);
    const reason = expectRefused(boardOf(engine), B, BID(DH, 75));
    expect(reason).toContain("1 certificate over the limit, counting the private companies you already have bids on as won");
    // Without the standing bid the same bid is legal.
    const alone = engineFrom(limitBoard({ cards: 19 }));
    send(alone, B, BID(DH, 75));
  });

  it("13. a bid legal when placed is honoured after an involuntary event makes its award an incurable excess", () => {
    const engine = engineFrom(limitBoard({ cards: 19 }));
    send(engine, B, BID(CS, 45)); // 20 with it: legal
    send(engine, C, BID(MH, 115));
    send(engine, A, BID(DH, 75));
    play(engine, Array(12).fill("pass")); // B takes the SV at $0, then the cascade awards the C&SL to him
    const board = boardOf(engine);
    expect(ownerOf(board, SV)).toBe(B);
    expect(ownerOf(board, CS)).toBe(B);
    expect(ownerOf(board, DH)).toBe(A);
    expect(ownerOf(board, MH)).toBe(C);
    expect(countOf(board, B)).toBe(21);
    expect(incurableExcess(excessOf(board, B)).certificates).toBe(1);
  });

  it("14. the forced $0 SV is taken even when it leaves an incurable excess", () => {
    const engine = engineFrom(limitBoard({ cards: 20 }));
    play(engine, Array(12).fill("pass"));
    const board = boardOf(engine);
    expect(ownerOf(board, SV)).toBe(B);
    expect(countOf(board, B)).toBe(21);
    expect(incurableExcess(excessOf(board, B)).certificates).toBe(1);
  });

  it("15 + 17. a curable overage holds the next Stock Round's seat: no pass and no purchase until the sale is made", () => {
    const engine = engineFrom(limitBoard({ cards: 20, roomIn: "NNH" }));
    send(engine, B, BUY); // the SV: 21, curable -- one 10% of the NNH can go to its pool
    play(engine, ["buy", "buy", "pass", "buy", "buy", "pass", "buy"]); // C C&SL, A D&H, B -, C M&H, A C&A, B -, C B&O
    const sr = handOff(engine);
    expect(seatOf(sr)).toBe(A); // left of C, the last buyer (DA-4)
    stockPass(engine);
    const held = boardOf(engine);
    expect(seatOf(held)).toBe(B);
    const debt = divestmentDebt({ state: held, player: B, ...chartForDivestment(held) });
    expect(debt.owed).toBe(true);
    expect(debt.certificatesOver).toBe(1);
    expect(divestmentPassRefusal(held)).not.toBeNull();
    // 15. no pass (both locks) ...
    // (The sentence is #759's zone-exit wording -- misleading for an auction's overage; DA-F8's copy pass, DA-6, owns it.)
    expect(expectRefused(held, B, PASS_TURN)).toContain("1 certificate over the limit of 20");
    // 17. ... and no ordinary purchase while the curable excess remains -- not even a Yellow-zone share, which counts
    // toward no limit: the hold is what refuses it.
    expect(expectRefused(held, B, SHARE(held, "NYC"))).toContain("1 certificate over the limit of 20");
    expectRefused(held, B, SHARE(held, "PRR")); // (a counted share meets the limit itself first)
    // The sale cures it; then the turn goes on, and the purchase the hold refused is legal.
    send(engine, B, SELL(held, "NNH", 10));
    const sold = boardOf(engine);
    expect(countOf(sold, B)).toBe(20);
    expect(divestmentPassRefusal(sold)).toBeNull();
    send(engine, B, PASS_TURN); // Sell -> Buy
    send(engine, B, SHARE(boardOf(engine), "NYC"));
    expect(heldBy(boardOf(engine), "NYC", B)).toBe(10);
    expect(countOf(boardOf(engine), B)).toBe(20);
  });

  it("16. an incurable overage does not deadlock: nothing is owed and the seat may pass", () => {
    const engine = engineFrom(limitBoard({ cards: 20 }));
    play(engine, Array(12).fill("pass")); // B takes the SV at $0: 21, and no share of his can be sold
    play(engine, ["buy", "buy", "pass", "buy", "buy", "pass", "buy"]);
    handOff(engine);
    stockPass(engine); // A
    const board = boardOf(engine);
    expect(seatOf(board)).toBe(B);
    expect(countOf(board, B)).toBe(21);
    const excess = excessOf(board, B);
    expect([excess.certificatesOver, excess.curableCertificates]).toEqual([1, 0]);
    expect(divestmentDebt({ state: board, player: B, ...chartForDivestment(board) }).owed).toBe(false);
    expect(divestmentPassRefusal(board)).toBeNull();
    stockPass(engine);
    expect(seatOf(boardOf(engine))).toBe(C);
  });

  it("16b. STANDARD GAME CHANGE: a Classic excess no legal sale can cure is no longer owed -- a curable one still is", () => {
    for (const [roomIn, owed] of [[undefined, false], ["NNH", true]] as const) {
      const board = limitBoard({ cards: 20, roomIn });
      const standard = {
        ...board,
        variants: resolveVariants({ ...board.variants, delayedAuction: false }),
        current_round_type: "StockRound",
        private_companies: board.private_companies.map((entry) => (entry.private_id === SV ? { ...entry, owner: B } : entry)),
      } as State;
      expect(countOf(standard, B)).toBe(21);
      expect([roomIn ?? "none", divestmentDebt({ state: standard, player: B, ...chartForDivestment(standard) }).owed]).toEqual([
        roomIn ?? "none",
        owed,
      ]);
    }
  });
});

/* ================================================================================================== */
/* THE PHASE-5 BOARD. DA-4's real game (A started the PRR; B holds the Priority Deal), then HAND-BUILT: the Operating Round
   set in which the first 3-train was bought has run on to its last train of Phase 4 -- every 4-train owned (NYC one,
   CPR two, B&M one) -- and the auction it owes has not happened yet. The NYC (C) is buying trains; the PRR is 90%
   held (A 50, C 40), so the only certificate in its IPO is the reserved one. */
function phaseFiveEve(): State {
  const real = DA4_STOCK_ROUND();
  expect(holderOf(real)).toBe(B);
  const nyc = companyOf(real, "NYC");
  return {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["4"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(C),
    operating_sub_phase: "Hardware",
    public_companies: real.public_companies.map((company) => {
      const floated = (president: string, trains: string[]) => ({
        ...company,
        is_floated: true,
        president,
        par_value: "100",
        treasury: "1000",
        owned_trains: trains,
        player_holdings: [{ player: president, percentage: 60 }],
        ipo_pool_percentage: 40,
      });
      if (company.ticker === "NYC") return { ...floated(C, ["4"]), station_token_hexes: ["G19"] };
      if (company.ticker === "CPR") return floated(A, ["4", "4"]);
      if (company.ticker === "B&M") return floated(B, ["4"]);
      if (company.ticker === "PRR") {
        return {
          ...company,
          is_floated: true,
          treasury: "1000",
          ipo_pool_percentage: 10,
          player_holdings: [
            { player: A, percentage: 50 },
            { player: C, percentage: 40 },
          ],
        };
      }
      return company;
    }),
  } as State;
}

/** The first 5-train, bought for real through both locks; then the NYC's turn ends and with it the set. */
function firstFiveThenSetEnd(engine: Engine): { afterFive: State; opened: State } {
  send(engine, C, TRAIN(boardOf(engine), "NYC", "5"));
  const afterFive = boardOf(engine);
  expect(companyOf(afterFive, "NYC").owned_trains).toEqual(["4", "5"]);
  for (let guard = 0; boardOf(engine).current_round_type === "OperatingRound"; guard += 1) {
    if (guard > 4) throw new Error("the Operating Round set did not end");
    send(engine, C, PASS_TURN);
  }
  return { afterFive, opened: boardOf(engine) };
}

describe("D-55 / DA-F9: the first 5-train before a pending Delayed Auction cancels it", () => {
  it("18-22. the unsold privates close, the auction never arms, the reserved certificate returns, the B&O unlocks, nothing closed is offered", () => {
    const eve = phaseFiveEve();
    expect(eve.private_auction_complete).toBe(false);
    expect(boIsLocked(resolveVariants(eve.variants), eve.private_auction_complete)).toBe(true);
    expect(ordinaryPercentAvailable(companyOf(eve, "PRR"), "Ipo")).toBe(0);
    const engine = engineFrom(eve);
    const { afterFive, opened } = firstFiveThenSetEnd(engine);
    // 18. every unsold private closed, none sold.
    expect(afterFive.private_companies.map((entry) => [entry.private_id, entry.closed, entry.owner ?? null])).toEqual(
      [SV, CS, DH, MH, CA, BO].map((id) => [id, true, null]),
    );
    // 19. the auction is over for good -- and the set's end opens a Stock Round, not the auction.
    expect(afterFive.private_auction_complete).toBe(true);
    expect(opened.current_round_type).toBe("StockRound");
    expect(opened.waterfall?.waterfall_auction_active).toBe(false);
    // 20. the reserved certificate is ordinary supply again, in the IPO where it always was.
    expect(companyOf(afterFive, "PRR").reserved_certificate ?? null).toBeNull();
    expect(companyOf(afterFive, "PRR").ipo_pool_percentage).toBe(10);
    expect(ordinaryPercentAvailable(companyOf(afterFive, "PRR"), "Ipo")).toBe(10);
    // 21. the B&O is no longer locked behind a private nobody can buy.
    expect(boIsLocked(resolveVariants(afterFive.variants), afterFive.private_auction_complete)).toBe(false);
    // 22. nothing closed is offered, and every auction message is refused at both locks.
    expect(opened.waterfall?.privates).toEqual([]);
    expect(opened.waterfall?.mini_auction ?? null).toBeNull();
    for (const player of [A, B, C]) {
      expectRefused(opened, player, BUY);
      expectRefused(opened, player, BID(BO, 225));
    }
    // And the Stock Round trades what the cancellation freed: B starts the B&O; C buys the certificate that was reserved.
    expect(seatOf(opened)).toBe(B);
    stockBuy(engine, "B&O", 100);
    expect(companyOf(boardOf(engine), "B&O").president).toBe(B);
    expect(seatOf(boardOf(engine))).toBe(C);
    stockBuy(engine, "PRR");
    expect(heldBy(boardOf(engine), "PRR", C)).toBe(50);
    expect(companyOf(boardOf(engine), "PRR").ipo_pool_percentage).toBe(0);
  });

  it("23. the next Stock Round opens the ordinary way on the Priority Deal holder -- not the auction's dormant cursor, not the last president", () => {
    const eve = phaseFiveEve();
    const dormant = cursorOf(eve);
    expect(dormant).toBe(A); // dealt seat 0, never armed
    const { opened } = firstFiveThenSetEnd(engineFrom(eve));
    expect(opened.current_round_type).toBe("StockRound"); // the ordinary opening -- no auction armed on anybody
    expect(opened.waterfall?.waterfall_auction_active).toBe(false);
    expect(holderOf(opened)).toBe(B);
    expect(seatOf(opened)).toBe(B);
    expect(seatOf(opened)).not.toBe(dormant);
    expect(seatOf(opened)).not.toBe(C);
    expect(opened.macro_round_number).toBe(eve.macro_round_number + 1);
  });

  it("24. RevertTo across the cancellation restores the pending auction, and replaying it -- or restoring the room -- lands on the same board", () => {
    const eve = phaseFiveEve();
    let n = 0;
    const room = new RoomSession({
      providers: providersFor(eve) as never,
      seed: { state: eve, waterfall: eve.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `r${(n += 1)}`,
    });
    const submit = (actor: string, msg: unknown) =>
      room.submit({ actor, build: BUILD, msg: msg as never, baseIndex: room.nextIndex - 1, host: A });
    const fiveIndex = room.nextIndex;
    const playFiveAndSetEnd = () => {
      expect(submit(C, TRAIN(room.state, "NYC", "5")).kind).toBe("applied");
      for (let guard = 0; room.state.current_round_type === "OperatingRound"; guard += 1) {
        if (guard > 4) throw new Error("the set did not end");
        expect(submit(C, PASS_TURN).kind).toBe("applied");
      }
    };
    playFiveAndSetEnd();
    const cancelled = room.state;
    expect(cancelled.private_auction_complete).toBe(true);
    expect(submit(C, { RevertTo: { index: fiveIndex, player: C, summary: "the first 5-train" } }).kind).toBe("applied");
    // Behind the purchase: the auction is owed again, its offer whole, the certificate reserved, the privates open.
    expect(room.state.private_auction_complete).toBe(false);
    expect(room.state.waterfall?.privates).toHaveLength(6);
    expect(room.state.private_companies.every((entry) => !entry.closed)).toBe(true);
    expect(companyOf(room.state, "PRR").reserved_certificate).toEqual({ private_id: CA, percentage: 10 });
    expect(room.state.current_round_type).toBe("OperatingRound");
    playFiveAndSetEnd();
    expect(stateDigest(room.state)).toBe(stateDigest(cancelled));
    let m = 0;
    const restored = new RoomSession({
      providers: providersFor(eve) as never,
      seed: { state: eve, waterfall: eve.waterfall ?? null } as never,
      build: BUILD,
      mintId: () => `q${(m += 1)}`,
    });
    restored.restore(room.entries as never);
    expect(stateDigest(restored.state)).toBe(stateDigest(room.state));
  });

  it("24b. the transition itself: idempotent, and the standard game's Phase 5 closes its privates exactly as before", () => {
    const eve = phaseFiveEve();
    const once = applyPhaseChange(eve, "5");
    expect(once.private_auction_complete).toBe(true);
    expect(stateDigest(applyPhaseChange(once, "5"))).toBe(stateDigest(once));
    // A pending auction whose privates were already marked closed is still cancelled (the no-change return is asked after).
    const markedClosed = { ...eve, private_companies: eve.private_companies.map((entry) => ({ ...entry, closed: true })) } as State;
    expect(applyPhaseChange(markedClosed, "5").private_auction_complete).toBe(true);
    // Standard: the auction ran at the start; the phase closes the privates and touches nothing of the auction's.
    const standard = { ...boardOf(dealt(false)), private_auction_complete: true } as State;
    const closed = applyPhaseChange(standard, "5");
    expect(closed.private_companies.every((entry) => entry.closed)).toBe(true);
    expect(closed.waterfall).toBe(standard.waterfall);
    expect(closed.private_auction_complete).toBe(true);
    expect(closed.public_companies).toBe(standard.public_companies);
  });
});
