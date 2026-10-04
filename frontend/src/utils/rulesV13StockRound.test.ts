/** @jest-environment node */
// frontend/src/utils/rulesV13StockRound.test.ts
//
// ==================================================================
//  PHASE 3 W3-K (RULES ENGINE v13): THE STOCK ROUND UNDER RULES REVISION 2
// ==================================================================
//
// OD-2 (owner rule, 2026-10-03): sell whenever otherwise legal; at most one ordinary Buy action; after buying, Buy is
// unavailable and Sell stays legal; ONE "Pass Turn" message ends the turn. A turn that bought or sold ends without
// counting toward the all-pass streak; a turn that did nothing is a true pass.
//
// SBS-3 / SBS-4 (the official / default rulebook rule, p.13 -- NOT the optional V-6.3 "Buy All"): while a
// corporation's token is in a brown box, any number of certificates FROM THE BANK POOL of that ONE corporation may be
// bought as the turn's one purchase. Only a Brown-zone Bank Pool purchase opens the continuation; an IPO purchase is
// the turn's ordinary one purchase; a sale ends the Buy action.
//
// Maintained from the verification evidence `docs/phase3/v13_evidence/od2Sbs.test.ts.txt` (9b3f60b), rewritten for the
// final owner rulings. Every board is a v13 board (pin 13, rules revision 2) unless it says revision 1.

import { applySandboxAction, stockTurnStage } from "../gameEngine/sandboxSession";
import { CURRENT_RULES_REVISION, STANDARD_VARIANTS, passEndsStockTurn, brownPoolContinuationInForce, resolveVariants } from "../gameEngine/gameVariants";
import { chartContextFromState, stockPurchaseRefusal } from "../gameEngine/stockTransactionAuthority";
import { marketCellForPrice, marketZoneForPrice } from "../gameEngine/marketGeometry";
import { divestmentPassRefusal } from "../gameEngine/forcedDivestment";
import { turnRefusal } from "../gameEngine/turnAuthority";
import { replayLog } from "../gameEngine/replayLog";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { stateDigest } from "../gameEngine/stateDigest";
import { DEVELOPMENT_CORPUS_POLICY } from "../gameEngine/rulesVersion";
import type { GameStateResponse } from "../gameEngine/gameState";

const SEATS = ["p0", "p1", "p2", "p3"];
const PRR = 1;
const CPR = 2;
const NYC = 3;
const BO = 4;

function mark(company_id: number, price: number, enteredAt: number) {
  const cell = marketCellForPrice(price);
  if (!cell) throw new Error(`no cell for ${price}`);
  return { x: cell.x, y: cell.y, price, enteredAt, company_id };
}

/** A v13 Stock Round: PRR Normal ($100), CPR Brown ($30: started at $76, 20% left in its IPO, 30% in its Bank Pool),
 *  NYC Normal ($90), B&O Brown ($27, 20% in its Bank Pool) -- p0 holds NYC 10% to sell. */
function board(over: Partial<GameStateResponse> = {}, rules = CURRENT_RULES_REVISION): GameStateResponse {
  return {
    player_addresses: SEATS,
    player_cash: SEATS.map((player) => ({ player, cash_vgp: "2000" })),
    private_companies: [],
    current_round_type: "StockRound",
    macro_round_number: 4,
    active_player_index: 0,
    consecutive_passes: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    rules_engine_version: rules >= 2 ? 13 : 12,
    variants: { ...STANDARD_VARIANTS, rules },
    public_companies: [
      {
        company_id: PRR, ticker: "PRR", president: "p1", par_value: "100",
        ipo_pool_percentage: 30, bank_pool_percentage: 10,
        player_holdings: [ { player: "p0", percentage: 20 }, { player: "p1", percentage: 40 } ],
        station_token_hexes: [],
      },
      {
        company_id: CPR, ticker: "CPR", president: "p2", par_value: "76",
        ipo_pool_percentage: 20, bank_pool_percentage: 30,
        player_holdings: [ { player: "p2", percentage: 30 }, { player: "p3", percentage: 20 } ],
        station_token_hexes: [],
      },
      {
        company_id: NYC, ticker: "NYC", president: "p3", par_value: "90",
        ipo_pool_percentage: 40, bank_pool_percentage: 0,
        player_holdings: [ { player: "p0", percentage: 10 }, { player: "p3", percentage: 50 } ],
        station_token_hexes: [],
      },
      {
        company_id: BO, ticker: "B&O", president: "p1", par_value: "67",
        ipo_pool_percentage: 20, bank_pool_percentage: 20,
        player_holdings: [ { player: "p1", percentage: 60 } ],
        station_token_hexes: [],
      },
    ],
    market_positions: { [PRR]: mark(PRR, 100, 1), [CPR]: mark(CPR, 30, 2), [NYC]: mark(NYC, 90, 3), [BO]: mark(BO, 27, 4) },
    ...over,
  } as unknown as GameStateResponse;
}

const seatOf = (s: GameStateResponse) => s.player_addresses[s.active_player_index];
const ctxOf = (s: GameStateResponse, actor = seatOf(s)) => {
  const chart = chartContextFromState(s);
  return { actor, marketZoneFor: chart.marketZoneFor, marketPricesByCompany: chart.marketPricesByCompany, zoneForPrice: chart.zoneForPrice } as never;
};
const act = (s: GameStateResponse, msg: unknown, actor?: string) => applySandboxAction(s, msg as never, ctxOf(s, actor));
const BUY = (id: number, source: "Ipo" | "Bank", quantity?: number) =>
  ({ BuyStock: { game_id: 1, protocol_id: id, source, ...(quantity === undefined ? {} : { quantity }) } });
const SELL = (id: number, percentage = 10) => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
const PASS = { PassTurn: { game_id: 1 } };
const buy = (s: GameStateResponse, id: number, source: "Ipo" | "Bank", quantity?: number) => act(s, BUY(id, source, quantity));
const sell = (s: GameStateResponse, id: number, percentage = 10) => act(s, SELL(id, percentage));
const pass = (s: GameStateResponse) => act(s, PASS);
const refusal = (s: GameStateResponse, id: number, source: "Ipo" | "Bank") =>
  stockPurchaseRefusal({ state: s, buy: { companyId: id, source }, actor: seatOf(s), ctx: chartContextFromState(s) });
const holding = (s: GameStateResponse, id: number, who = "p0") =>
  s.public_companies.find((c) => c.company_id === id)!.player_holdings.find((h) => h.player === who)?.percentage ?? 0;
const cash = (s: GameStateResponse, who = "p0") => Number(s.player_cash.find((entry) => entry.player === who)!.cash_vgp);
const ingress = (s: GameStateResponse, actor: string, msg: unknown) => turnRefusal({ state: s, waterfall: null, actor, msg: msg as never });
/** A refusal returns the board unchanged (a charted board comes back as a fresh object, so by digest). */
const unchanged = (a: GameStateResponse, b: GameStateResponse) => stateDigest(a) === stateDigest(b);

describe("rules revision 2 is what v13 deals", () => {
  it("revision 2 switches all three corrections; revision 1 and 0 switch none", () => {
    expect(CURRENT_RULES_REVISION).toBe(2);
    expect(STANDARD_VARIANTS.rules).toBe(2);
    for (const predicate of [passEndsStockTurn, brownPoolContinuationInForce]) {
      expect(predicate(resolveVariants({ rules: 2 }))).toBe(true);
      expect(predicate(resolveVariants({ rules: 1 }))).toBe(false);
      expect(predicate(resolveVariants({}))).toBe(false);
    }
  });
  it("the chart facts the Brown cases rest on: CPR and B&O are Brown, PRR and NYC are not", () => {
    expect(marketZoneForPrice(30)).toBe("Brown");
    expect(marketZoneForPrice(27)).toBe("Brown");
    expect(marketZoneForPrice(100)).not.toBe("Brown");
    expect(marketZoneForPrice(90)).not.toBe("Brown");
  });
});

/* ------------------------------------------------------------------ */
/* OD-2: one Pass Turn                                                */
/* ------------------------------------------------------------------ */

describe("OD-2: one PassTurn ends the Stock Round turn (tests 1-10)", () => {
  it("1. an untouched turn: ONE PassTurn ends it and counts as a true pass; no stage is ever written", () => {
    const passed = pass(board());
    expect(passed.active_player_index).toBe(1);
    expect(passed.consecutive_passes).toBe(1);
    expect(passed.stock_turn_stage).toBeUndefined();
    expect(stockTurnStage(passed)).toBe("sell");
  });

  it("2. an acted turn: buy, then PassTurn ends it and does NOT count as a no-action pass", () => {
    const start = board({ consecutive_passes: 2 } as Partial<GameStateResponse>);
    const bought = buy(start, PRR, "Ipo");
    expect(holding(bought, PRR)).toBe(30);
    expect(bought.active_player_index).toBe(0); // the buy leaves the seat with the buyer
    const ended = pass(bought);
    expect(ended.active_player_index).toBe(1);
    expect(ended.consecutive_passes).toBe(0);
  });

  it("3. sell, then PassTurn ends the turn correctly (acted: streak reset)", () => {
    const sold = sell(board({ consecutive_passes: 2 } as Partial<GameStateResponse>), NYC);
    expect(holding(sold, NYC)).toBe(0);
    expect(sold.active_player_index).toBe(0);
    const ended = pass(sold);
    expect(ended.active_player_index).toBe(1);
    expect(ended.consecutive_passes).toBe(0);
  });

  it("4. sell before buy remains legal", () => {
    const sold = sell(board(), NYC);
    const bought = buy(sold, PRR, "Ipo");
    expect(holding(bought, PRR)).toBe(30);
    expect(bought.bought_this_turn).toBe(1);
  });

  it("5. the ordinary buy limit remains one -- IPO or Bank Pool, refused at both locks", () => {
    const bought = buy(board(), PRR, "Ipo");
    expect(refusal(bought, PRR, "Ipo")).toContain("One certificate purchase per turn");
    expect(refusal(bought, PRR, "Bank")).toContain("One certificate purchase per turn");
    expect(refusal(bought, NYC, "Ipo")).not.toBeNull();
    expect(unchanged(buy(bought, PRR, "Ipo"), bought)).toBe(true);
    expect(unchanged(buy(bought, NYC, "Ipo"), bought)).toBe(true);
    expect(ingress(bought, "p0", BUY(PRR, "Ipo"))).toContain("One certificate purchase per turn");
  });

  it("6. sell after buy remains legal, and Buy stays unavailable after it", () => {
    const bought = buy(board(), PRR, "Ipo");
    const sold = sell(bought, NYC);
    expect(holding(sold, NYC)).toBe(0);
    expect(sold.active_player_index).toBe(0);
    expect(refusal(sold, PRR, "Ipo")).not.toBeNull();
    expect(pass(sold).active_player_index).toBe(1);
  });

  it("7. a must-sell obligation still refuses the one Pass, at the reducer and at ingress", () => {
    // p0 holds 70% of PRR with the token in the Normal zone: a curable excess over the 60% cap.
    const over = board({
      public_companies: board().public_companies.map((company) =>
        company.company_id === PRR
          ? { ...company, ipo_pool_percentage: 0, bank_pool_percentage: 0, president: "p0", player_holdings: [{ player: "p0", percentage: 70 }, { player: "p1", percentage: 30 }] }
          : company,
      ),
    } as Partial<GameStateResponse>);
    expect(divestmentPassRefusal(over)).not.toBeNull();
    expect(unchanged(pass(over), over)).toBe(true);
    expect(ingress(over, "p0", PASS)).toBe(divestmentPassRefusal(over));
    // The sale cures it, and then the one Pass ends the turn.
    const cured = sell(over, PRR);
    expect(divestmentPassRefusal(cured)).toBeNull();
    expect(pass(cured).active_player_index).toBe(1);
  });

  it("8. the sold-this-round lockout is still enforced", () => {
    const sold = sell(board(), NYC);
    expect(refusal(sold, NYC, "Ipo")).toContain("You sold NYC this Stock Round");
    expect(unchanged(buy(sold, NYC, "Ipo"), sold)).toBe(true);
  });

  it("9 + 10. Priority Deal stays left of the last trader, and N consecutive true passes end the round", () => {
    let s = buy(board(), PRR, "Ipo"); // p0 trades
    s = pass(s); // p0 ends, acted
    expect(s.consecutive_passes).toBe(0);
    expect(s.last_trader_index).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      s = pass(s);
      expect(s.current_round_type === "StockRound" && s.stock_round_just_ended !== true).toBe(true);
    }
    expect(s.consecutive_passes).toBe(3);
    s = pass(s); // the fourth consecutive true pass
    expect(s.macro_round_number).not.toBe(4); // the round turned over (the transition opened the next round)
    expect(s.priority_deal_index).toBe(1); // left of p0, the last trader
    expect(s.last_trader_index).toBeNull();
  });

  it("a purchase in the middle of a streak resets it; a pass never marks a trader", () => {
    let s = pass(board()); // p0 (1)
    s = pass(s); // p1 (2)
    expect(s.last_trader_index).toBeNull();
    s = buy(s, NYC, "Ipo"); // p2 buys
    s = pass(s);
    expect(s.consecutive_passes).toBe(0);
    expect(s.active_player_index).toBe(3);
    expect(s.last_trader_index).toBe(2);
  });

  it("revision 1 (a v12-era log) keeps the stage walk: the first Pass only moves Sell -> Buy", () => {
    const legacy = board({}, 1);
    const first = pass(legacy);
    expect(first.active_player_index).toBe(0);
    expect(first.stock_turn_stage).toBe("buy");
    const second = pass(first);
    expect(second.active_player_index).toBe(1);
    expect(second.consecutive_passes).toBe(1);
  });

  it("replay is deterministic: a revision-2 log of single Passes rebuilds byte for byte", () => {
    const entry = (index: number, actor: string, msg: unknown) => ({ index, id: `e${index}`, actor, payload: JSON.stringify(msg) });
    const entries = [entry(0, "p0", BUY(PRR, "Ipo")), entry(1, "p0", PASS), entry(2, "p1", PASS), entry(3, "p2", SELL(NYC)), entry(4, "p2", PASS)];
    // p2 holds no NYC: that sale is refused and the PassTurn after it is a true pass.
    const seed = () => ({ state: board(), waterfall: null });
    const once = replayLog(entries, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    const twice = replayLog(entries, sandboxReplayProviders(), seed(), undefined, DEVELOPMENT_CORPUS_POLICY);
    expect(stateDigest(once.state)).toBe(stateDigest(twice.state));
    expect(once.state.active_player_index).toBe(3);
    expect(once.state.consecutive_passes).toBe(2);
    expect(holding(once.state, PRR)).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* SBS-3 / SBS-4: the official Brown Bank Pool continuation           */
/* ------------------------------------------------------------------ */

describe("the official Brown Bank Pool rule (SBS-3 / SBS-4), not V-6.3 Buy All", () => {
  it("LEGAL: Brown Pool CPR -> Pool CPR, and -> Pool CPR again (same corporation throughout)", () => {
    const one = buy(board(), CPR, "Bank");
    expect(one.brown_pool_continuation_company).toBe(CPR);
    const two = buy(one, CPR, "Bank");
    const three = buy(two, CPR, "Bank");
    expect(holding(three, CPR)).toBe(30);
    expect(three.bought_this_turn).toBe(3);
    expect(three.brown_pool_continuation_company).toBe(CPR);
    expect(cash(three)).toBe(2000 - 3 * 30);
  });

  it("LEGAL: one message taking several Brown Bank Pool certificates, and a continuation after it", () => {
    const two = buy(board(), CPR, "Bank", 2);
    expect(holding(two, CPR)).toBe(20);
    expect(two.brown_pool_continuation_company).toBe(CPR);
    expect(holding(buy(two, CPR, "Bank"), CPR)).toBe(30);
  });

  it("REFUSED (SBS-4): IPO CPR -> Pool CPR -- the IPO purchase was the turn's one purchase and opens nothing", () => {
    const ipo = buy(board(), CPR, "Ipo");
    expect(holding(ipo, CPR)).toBe(10);
    expect(cash(ipo)).toBe(2000 - 76); // the IPO share is sold at par
    expect(ipo.brown_pool_continuation_company).toBeUndefined();
    expect(refusal(ipo, CPR, "Bank")).toContain("One certificate purchase per turn");
    expect(unchanged(buy(ipo, CPR, "Bank"), ipo)).toBe(true);
    expect(ingress(ipo, "p0", BUY(CPR, "Bank"))).toContain("One certificate purchase per turn");
  });

  it("REFUSED: Pool CPR -> IPO CPR -- the Brown exception is Bank Pool only", () => {
    const pool = buy(board(), CPR, "Bank");
    expect(refusal(pool, CPR, "Ipo")).not.toBeNull();
    expect(unchanged(buy(pool, CPR, "Ipo"), pool)).toBe(true);
  });

  it("REFUSED (SBS-3): Pool CPR -> Sell NYC -> Pool CPR -- a sale ends the Brown Buy action and it never reopens", () => {
    const pool = buy(board(), CPR, "Bank");
    const sold = sell(pool, NYC);
    expect(holding(sold, NYC)).toBe(0);
    expect(sold.brown_pool_continuation_company).toBeUndefined();
    expect(refusal(sold, CPR, "Bank")).toContain("One certificate purchase per turn");
    expect(unchanged(buy(sold, CPR, "Bank"), sold)).toBe(true);
    expect(ingress(sold, "p0", BUY(CPR, "Bank"))).toContain("One certificate purchase per turn");
  });

  it("REFUSED: Pool CPR -> Pool B&O -- several certificates of ONE corporation, even when both are Brown", () => {
    expect(refusal(board(), BO, "Bank")).toBeNull(); // control: B&O's Bank Pool certificate is buyable as a first purchase
    const pool = buy(board(), CPR, "Bank");
    // Double-gated: the v13 continuation names CPR, and v12's rule 7 (`bought_this_turn_company`) names it too.
    expect(refusal(pool, BO, "Bank")).not.toBeNull();
    expect(unchanged(buy(pool, BO, "Bank"), pool)).toBe(true);
    expect(ingress(pool, "p0", BUY(BO, "Bank"))).not.toBeNull();
  });

  it("REFUSED: a non-Brown Bank Pool purchase opens nothing -- Pool PRR -> a second purchase", () => {
    const pool = buy(board(), PRR, "Bank");
    expect(holding(pool, PRR)).toBe(30);
    expect(pool.brown_pool_continuation_company).toBeUndefined();
    expect(refusal(pool, CPR, "Bank")).not.toBeNull();
    expect(unchanged(buy(pool, CPR, "Bank"), pool)).toBe(true);
  });

  it("Pass Turn closes the continuation: the state clears on the seat advance, and the player's turn is over", () => {
    const pool = buy(board(), CPR, "Bank");
    const passed = pass(pool);
    expect(passed.active_player_index).toBe(1);
    expect(passed.consecutive_passes).toBe(0);
    expect(passed.brown_pool_continuation_company).toBeUndefined();
    expect(passed.bought_this_turn).toBe(0);
    expect(ingress(passed, "p0", BUY(CPR, "Bank"))).toBe("It is not your turn.");
  });

  it("the state clears at round end too", () => {
    let s = buy(board(), CPR, "Bank");
    s = pass(s); // p0 acted
    for (let i = 0; i < 4; i += 1) s = pass(s);
    expect(s.macro_round_number).not.toBe(4);
    expect(s.brown_pool_continuation_company).toBeUndefined();
  });

  it("an empty Bank Pool is refused, and cash is still required", () => {
    let s = buy(board(), CPR, "Bank");
    s = buy(s, CPR, "Bank");
    s = buy(s, CPR, "Bank");
    expect(holding(s, CPR)).toBe(30); // the pool's three certificates
    expect(refusal(s, CPR, "Bank")).not.toBeNull();
    expect(unchanged(buy(s, CPR, "Bank"), s)).toBe(true);
    const poor = board({ player_cash: SEATS.map((player) => ({ player, cash_vgp: player === "p0" ? "45" : "2000" })) } as Partial<GameStateResponse>);
    const first = buy(poor, CPR, "Bank");
    expect(holding(first, CPR)).toBe(10);
    expect(refusal(first, CPR, "Bank")).toContain("That purchase costs $30 and you hold $15.");
    expect(unchanged(buy(first, CPR, "Bank"), first)).toBe(true);
  });

  it("the other standing purchase rules still apply: a corporation sold this round cannot be bought back, even in Brown", () => {
    const holder = board({
      public_companies: board().public_companies.map((company) =>
        company.company_id === CPR ? { ...company, player_holdings: [...company.player_holdings, { player: "p0", percentage: 10 }], bank_pool_percentage: 20 } : company,
      ),
    } as Partial<GameStateResponse>);
    const sold = sell(holder, CPR);
    expect(refusal(sold, CPR, "Bank")).toContain("You sold CPR this Stock Round");
  });

  it("revision 1 (a v12-era log) replays v12's reading: IPO -> Pool and Pool -> Sell -> Pool are both accepted", () => {
    const legacy = board({}, 1);
    const ipo = buy(legacy, CPR, "Ipo");
    expect(ipo.brown_pool_continuation_company).toBeUndefined();
    expect(holding(buy(ipo, CPR, "Bank"), CPR)).toBe(20);
    const pool = buy(legacy, CPR, "Bank");
    expect(pool.brown_pool_continuation_company).toBeUndefined(); // never written on revision 1
    const sold = sell(pool, NYC);
    expect(holding(buy(sold, CPR, "Bank"), CPR)).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* Owner rulings 2 and 3 (2026-10-04): intervening actions and the M&H  */
/* ------------------------------------------------------------------ */

const SV = 1; // Schuylkill Valley: p0's, for a player-to-player trade
const MH = 4; // Mohawk & Hudson: p0's, exchanges for an NYC 10%
/** The Stock Round board with two privates in p0's hand (the seat holder). */
function withPrivates(over: Partial<GameStateResponse> = {}): GameStateResponse {
  return board({
    private_companies: [
      { private_id: SV, name: "Schuylkill Valley", cost: "20", revenue_per_or: "5", owner: "p0", owner_protocol_id: null, closed: false },
      { private_id: MH, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: "p0", owner_protocol_id: null, closed: false },
    ],
    ...over,
  } as Partial<GameStateResponse>);
}
const PROPOSE = { ProposePrivateTrade: { game_id: 1, private_id: SV, seller: "p0", buyer: "p1", price: 30 } };
const ANSWER = (accept: boolean) => ({ AnswerPrivateTrade: { game_id: 1, private_id: SV, accept } });
const EXCHANGE_MH = (player = "p0") => ({ ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player, source: "Ipo" } });
const ownerOf = (s: GameStateResponse, id: number) => s.private_companies.find((entry) => entry.private_id === id)!;

describe("owner ruling 2: the Brown continuation is one contiguous purchase by the ACTIVE player", () => {
  it("A. Pool CPR -> an accepted private trade on p0's turn -> Pool CPR: the final Pool CPR is REFUSED", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    expect(pool.brown_pool_continuation_company).toBe(CPR);
    const proposed = act(pool, PROPOSE, "p0");
    expect(proposed.private_trade_offer?.private_id).toBe(SV);
    expect(proposed.brown_pool_continuation_company).toBe(CPR); // a proposal transacts nothing
    const traded = act(proposed, ANSWER(true), "p1"); // the counterparty's acceptance settles p0's trade
    expect(ownerOf(traded, SV).owner).toBe("p1");
    expect(traded.brown_pool_continuation_company).toBeUndefined();
    expect(seatOf(traded)).toBe("p0"); // the turn is still p0's ...
    expect(refusal(traded, CPR, "Bank")).toContain("One certificate purchase per turn"); // ... but the purchase is over
    expect(unchanged(buy(traded, CPR, "Bank"), traded)).toBe(true);
    expect(ingress(traded, "p0", BUY(CPR, "Bank"))).toContain("One certificate purchase per turn");
  });

  it("B. Pool CPR -> an M&H exchange by p0 on p0's own turn -> Pool CPR: the final Pool CPR is REFUSED", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    const exchanged = act(pool, EXCHANGE_MH("p0"), "p0");
    expect(ownerOf(exchanged, MH).closed).toBe(true);
    expect(holding(exchanged, NYC)).toBe(20); // executed at once: the owner's own turn
    expect(exchanged.brown_pool_continuation_company).toBeUndefined();
    expect(refusal(exchanged, CPR, "Bank")).toContain("One certificate purchase per turn");
    expect(unchanged(buy(exchanged, CPR, "Bank"), exchanged)).toBe(true);
  });

  it("C. Pool CPR -> another player's off-turn answer (a rejection) -> Pool CPR: the continuation remains", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    const rejected = act(act(pool, PROPOSE, "p0"), ANSWER(false), "p1");
    expect(rejected.private_trade_offer ?? null).toBeNull();
    expect(ownerOf(rejected, SV).owner).toBe("p0");
    expect(rejected.brown_pool_continuation_company).toBe(CPR);
    expect(refusal(rejected, CPR, "Bank")).toBeNull();
    expect(holding(buy(rejected, CPR, "Bank"), CPR)).toBe(20);
    // And a proposal the proposer withdraws is the same: nothing was transacted.
    const rescinded = act(act(pool, PROPOSE, "p0"), { RescindPrivateTrade: { game_id: 1, private_id: SV } }, "p0");
    expect(rescinded.brown_pool_continuation_company).toBe(CPR);
    expect(holding(buy(rescinded, CPR, "Bank"), CPR)).toBe(20);
  });

  it("C'. another player's off-turn M&H REQUEST (queued, not executed) does not close p0's continuation", () => {
    const base = withPrivates();
    const pool = buy(
      { ...base, private_companies: base.private_companies.map((entry) => (entry.private_id === MH ? { ...entry, owner: "p1" } : entry)) },
      CPR,
      "Bank",
    );
    const queued = act(pool, EXCHANGE_MH("p1"), "p1");
    expect(queued.pending_mh_exchange?.player).toBe("p1");
    expect(queued.brown_pool_continuation_company).toBe(CPR);
    expect(holding(buy(queued, CPR, "Bank"), CPR)).toBe(20);
  });

  it("C''. a derived entry attributed to nobody (\"\") is bookkeeping, never the active player's turn action", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    const proposed = act(pool, PROPOSE, "p0");
    const rejectedByNobody = applySandboxAction(proposed, ANSWER(false) as never, { ...(ctxOf(proposed) as object), actor: "" } as never);
    expect(rejectedByNobody.brown_pool_continuation_company).toBe(CPR);
    // A state-changing message that is NOT an answer, attributed to nobody (a system entry): it moves the board, yet it
    // is not the active player's turn action, so the purchase stays open.
    const bySystem = applySandboxAction(pool, EXCHANGE_MH("p0") as never, { ...(ctxOf(pool) as object), actor: "" } as never);
    expect(holding(bySystem, NYC)).toBe(20); // it did execute
    expect(bySystem.brown_pool_continuation_company).toBe(CPR);
  });

  it("D. a refused or no-op message does not close the continuation merely because it was attempted", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    // p0 offers a private p0 does not own: refused, board unchanged, the purchase still open.
    const refusedTrade = act(pool, { ProposePrivateTrade: { game_id: 1, private_id: 99, seller: "p0", buyer: "p1", price: 30 } }, "p0");
    expect(unchanged(refusedTrade, pool)).toBe(true);
    expect(refusedTrade.brown_pool_continuation_company).toBe(CPR);
    // An M&H exchange that is illegal (keep_open asserted) is refused and closes nothing.
    const refusedExchange = act(pool, { ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player: "p0", source: "Ipo", keep_open: true } }, "p0");
    expect(unchanged(refusedExchange, pool)).toBe(true);
    expect(refusedExchange.brown_pool_continuation_company).toBe(CPR);
    // An answer to an offer that does not exist is a no-op.
    const stray = act(pool, ANSWER(true), "p1");
    expect(stray.brown_pool_continuation_company).toBe(CPR);
    expect(holding(buy(stray, CPR, "Bank"), CPR)).toBe(20);
  });

  it("revision 1 is untouched: the same trade and exchange write no continuation key at all", () => {
    const legacy = withPrivates({ variants: { ...STANDARD_VARIANTS, rules: 1 }, rules_engine_version: 12 } as Partial<GameStateResponse>);
    const pool = buy(legacy, CPR, "Bank");
    const exchanged = act(pool, EXCHANGE_MH("p0"), "p0");
    expect(Object.prototype.hasOwnProperty.call(exchanged, "brown_pool_continuation_company")).toBe(false);
  });
});

describe("owner ruling 3: an M&H exchange is NOT stock trading -- yet it closes an open Brown purchase", () => {
  it("an M&H exchange alone, then Pass Turn: the Pass is a TRUE pass (streak counts; no turn action; Priority Deal unmoved)", () => {
    const start = withPrivates({ consecutive_passes: 1, last_trader_index: 2 } as Partial<GameStateResponse>);
    const exchanged = act(start, EXCHANGE_MH("p0"), "p0");
    expect(holding(exchanged, NYC)).toBe(20);
    expect(exchanged.turn_action_taken ?? false).toBe(false);
    expect(exchanged.consecutive_passes).toBe(1);
    expect(exchanged.last_trader_index).toBe(2);
    const passed = pass(exchanged);
    expect(passed.consecutive_passes).toBe(2); // counted toward the all-pass streak
    expect(passed.last_trader_index).toBe(2); // not a trader
    expect(seatOf(passed)).toBe("p1");
  });

  it("the distinction, pinned: after Pool CPR the same exchange closes the purchase but leaves the turn's stock accounting alone", () => {
    const pool = buy(withPrivates(), CPR, "Bank");
    const exchanged = act(pool, EXCHANGE_MH("p0"), "p0");
    expect(exchanged.brown_pool_continuation_company).toBeUndefined(); // ruling 2
    expect(exchanged.bought_this_turn).toBe(pool.bought_this_turn); // ruling 3: not a purchase ...
    expect(exchanged.turn_action_taken).toBe(pool.turn_action_taken); // ... the BUY made this an acted turn, not the M&H
    expect(exchanged.last_trader_index).toBe(pool.last_trader_index);
    expect(exchanged.consecutive_passes).toBe(pool.consecutive_passes);
  });
});
