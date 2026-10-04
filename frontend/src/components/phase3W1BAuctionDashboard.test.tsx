/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W1-B: THE AUCTION DASHBOARD, RENDERED AND CLICKED
// ==================================================================
//
// AUD-02.01 (K-02 / U-26), AUD-02.02 (K-15), AUD-02.03, AUD-02.04 (H-04), P3-N005.
//
// Every verdict a card-face control shows is compared with the authority's own answer for the same message
// (`auctionRefusal`, the predicate the reducer's board gate and ingress both ask), and every enabled control's
// message is shown to be ACCEPTED by the reducer -- so "enabled" and "the board would take it" are pinned as one
// fact rather than assumed to be. The Delayed-Auction solvency case runs on a REAL board built by the room engine
// (DA-5's limit board, `da5PrivateConsequences.test.ts`), not a hand-made approximation of one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { WaterfallAuctionDashboard } from "./WaterfallAuctionDashboard";

type State = import("../gameEngine/gameState").GameStateResponse;
type Waterfall = import("../gameEngine/gameState").WaterfallStateResponse;
type WaterfallPrivateStatus = import("../gameEngine/gameState").WaterfallPrivateStatus;
type Engine = InstanceType<typeof import("../gameEngine/replayLog").RoomEngine>;

const { applySandboxAction, operatingRoundSequenceLength } =
  require("../gameEngine/sandboxSession") as typeof import("../gameEngine/sandboxSession");
const { auctionActor, auctionRefusal } =
  require("../gameEngine/auctionAuthority") as typeof import("../gameEngine/auctionAuthority");
const { turnRefusal } = require("../gameEngine/turnAuthority") as typeof import("../gameEngine/turnAuthority");
const { stateDigest } = require("../gameEngine/stateDigest") as typeof import("../gameEngine/stateDigest");
const { SV_PRIVATE_ID } = require("../gameEngine/gameConstants") as typeof import("../gameEngine/gameConstants");
const RL = require("../gameEngine/replayLog") as typeof import("../gameEngine/replayLog");
const { sandboxReplayProviders } =
  require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { withEmptyRoster, waterfallForRoster } =
  require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");
const SS = require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { actingAddress } = require("../gameEngine/gameState") as typeof import("../gameEngine/gameState");
const { RULES_ENGINE_VERSION } = require("../gameEngine/rulesVersion") as typeof import("../gameEngine/rulesVersion");
const { marketCellForPrice } =
  require("../gameEngine/marketGeometry") as typeof import("../gameEngine/marketGeometry");

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* ---- the standard board (the auction authority harness's shape) ------------------------------------------------ */

const A = "p-a";
const B = "p-b";
const C = "p-c";
const SEATS = [A, B, C];
const NAMES: Record<string, string> = { [A]: "Alice", [B]: "Bob", [C]: "Cara" };
const label = (address: string) => NAMES[address] ?? null;

const ROSTER: Array<[number, string, number, number]> = [
  [SV_PRIVATE_ID, "Schuylkill Valley", 20, 5],
  [2, "Champlain & St.Lawrence", 40, 10],
  [3, "Delaware & Hudson", 70, 15],
  [4, "Mohawk & Hudson", 110, 20],
];

function priv(id: number, bids: Array<[string, number]> = [], isLowest = false): WaterfallPrivateStatus {
  const row = ROSTER.find(([entry]) => entry === id)!;
  return {
    private_id: id,
    name: row[1],
    face_value: String(row[2]),
    is_lowest_offered: isLowest,
    bids: bids
      .map(([bidder, amount]) => ({ bidder, bid_amount: String(amount) }))
      .sort((a, b) => Number(a.bid_amount) - Number(b.bid_amount)),
  };
}

function board(options: {
  cash?: Record<string, number>;
  privates?: WaterfallPrivateStatus[];
  currentTurn?: string;
  mini?: Waterfall["mini_auction"];
}): State {
  return {
    current_round_type: "WaterfallAuction",
    macro_round_number: 1,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    active_player_index: 0,
    priority_deal_index: 0,
    consecutive_passes: 0,
    current_global_era: "Yellow",
    active_operating_order: [],
    active_corporation_index: 0,
    rules_engine_version: 4,
    variants: { rules: 1 },
    player_addresses: [...SEATS],
    player_cash: SEATS.map((player) => ({ player, cash_vgp: String(options.cash?.[player] ?? 600) })),
    virtual_bank_vgp: "9000",
    public_companies: [],
    private_companies: ROSTER.map(([id, name, cost, revenue]) => ({
      private_id: id,
      name,
      cost: String(cost),
      revenue_per_or: String(revenue),
      owner: null,
      owner_protocol_id: null,
      closed: false,
    })),
    waterfall: {
      game_id: 1,
      waterfall_auction_active: true,
      privates: options.privates ?? ROSTER.map(([id], index) => priv(id, [], index === 0)),
      current_turn: options.currentTurn ?? A,
      mini_auction: options.mini ?? null,
      consecutive_waterfall_passes: 0,
    },
  } as unknown as State;
}

/* ---- rendering ---------------------------------------------------------------------------------------------------- */

interface Spies {
  buy: jest.Mock;
  bid: jest.Mock;
  raise: jest.Mock;
  pass: jest.Mock;
}

function show(state: State, viewer: string, sessionReady = true): Spies {
  const spies: Spies = { buy: jest.fn(), bid: jest.fn(), raise: jest.fn(), pass: jest.fn() };
  act(() => {
    root.render(
      <WaterfallAuctionDashboard
        waterfallState={state.waterfall ?? null}
        loading={false}
        error={null}
        gameState={state}
        connectedWalletAddress={viewer}
        sessionReady={sessionReady}
        playerLabel={label}
        onBuyLowest={spies.buy}
        onBidHigher={spies.bid}
        onMiniAuctionRaise={spies.raise}
        onMiniAuctionPass={spies.pass}
      />,
    );
  });
  return spies;
}

const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
function button(text: string | RegExp): HTMLButtonElement {
  const found = buttons().filter((node) =>
    typeof text === "string" ? node.textContent?.trim() === text : text.test(node.textContent ?? ""),
  );
  if (found.length !== 1) throw new Error(`expected one button ${String(text)}, found ${found.length}`);
  return found[0];
}
function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
const bidInputFor = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Bid amount for ${name}"]`)!;

/** Asked of the reducer exactly as a room would: ingress first, then the board. */
function accepted(state: State, actor: string, msg: unknown): boolean {
  if (turnRefusal({ state, waterfall: state.waterfall ?? null, actor, msg: msg as never }) !== null) return false;
  const after = applySandboxAction(state, msg as never, { actor } as never);
  return stateDigest(after) !== stateDigest(state);
}

/* ================================================================================================================ */
describe("AUD-02.01 (K-02 / U-26): a player raises their own standing bid", () => {
  const ownBid = () =>
    board({
      privates: [priv(SV_PRIVATE_ID, [], true), priv(2, [[A, 45]]), priv(3), priv(4)],
      currentTurn: A,
    });

  it("the card offers Raise Bid at the authority's minimum and sends it; the reducer takes it", () => {
    const state = ownBid();
    const spies = show(state, A);
    const raise = button("Raise Bid");
    expect(raise.disabled).toBe(false);
    expect(bidInputFor("Champlain & St.Lawrence").value).toBe("50"); // minimumBidFor: own $45 high + $5
    expect(container.textContent).toContain("Raise your bid");
    expect(container.textContent).toContain("Your $45 bid stands");
    expect(container.textContent).not.toContain("One bid per private company");
    const msg = { WaterfallBidHigher: { game_id: 0, private_id: 2, bid_amount: "50" } };
    expect(auctionRefusal(state, state.waterfall ?? null, msg)).toBeNull();
    click(raise);
    expect(spies.bid).toHaveBeenCalledTimes(1);
    expect(spies.bid).toHaveBeenCalledWith(2, 50);
    // The board takes the message the button sent: one bid, replaced, at $50.
    expect(accepted(state, A, msg)).toBe(true);
    const after = applySandboxAction(state, msg as never, { actor: A } as never);
    expect(after.waterfall?.privates.find((entry) => entry.private_id === 2)?.bids).toEqual([
      { bidder: A, bid_amount: "50" },
    ]);
  });

  it("only the increase must be free: $3 short of it greys the raise with the authority's own sentence", () => {
    // $48 in hand, $45 already on this private: a $50 raise needs $5 more and only $3 is free.
    const state = board({
      privates: [priv(SV_PRIVATE_ID, [], true), priv(2, [[A, 45]]), priv(3), priv(4)],
      currentTurn: A,
      cash: { [A]: 48 },
    });
    show(state, A);
    const raise = button("Raise Bid");
    const verdict = auctionRefusal(state, state.waterfall ?? null, {
      WaterfallBidHigher: { game_id: 0, private_id: 2, bid_amount: "50" },
    });
    expect(verdict).not.toBeNull();
    expect(raise.disabled).toBe(true);
    expect(raise.title).toBe(verdict);
  });

  it("a bid below the authority's minimum is greyed with its sentence (the authority, not a dashboard copy)", () => {
    const state = ownBid();
    show(state, A);
    const input = bidInputFor("Champlain & St.Lawrence");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "47");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const raise = button("Raise Bid");
    expect(raise.disabled).toBe(true);
    expect(raise.title).toBe(
      auctionRefusal(state, state.waterfall ?? null, {
        WaterfallBidHigher: { game_id: 0, private_id: 2, bid_amount: "47" },
      }),
    );
  });
});

/* ================================================================================================================ */
describe("AUD-02.02 (K-15) / AUD-02.03: the contest's Pass tells the truth, and the contest says how close it is", () => {
  /* Three bidders on the D&H, queued ascending by their opening bids (B, C, A). A raised to $85; B has passed since;
     the cursor is on C. One more pass ends it (2 of the 3 bidders must pass: everyone but the leader). */
  const contest = () =>
    board({
      privates: [priv(SV_PRIVATE_ID, [], true), priv(2), priv(3, [[B, 75], [C, 80], [A, 85]]), priv(4)],
      currentTurn: B,
      mini: {
        private_id: 3,
        bidders: [B, C, A],
        current_turn: C,
        high_bid: "85",
        high_bidder: A,
        passes_since_raise: 1,
      } as Waterfall["mini_auction"],
    });

  it("the control reads Pass, says the bid stands, and nothing on screen promises a refund or a drop-out", () => {
    const state = contest();
    const spies = show(state, C);
    const pass = button("Pass");
    expect(pass.disabled).toBe(false);
    expect(pass.title).toContain("Your $80 bid stands");
    expect(pass.title).toContain("This pass ends the contest: Alice wins at $85");
    const everything = container.textContent + buttons().map((node) => node.title).join(" ");
    expect(everything).not.toMatch(/refunded|drop out/i);
    expect(auctionRefusal(state, state.waterfall ?? null, { WaterfallMiniAuctionPass: { game_id: 0 } })).toBeNull();
    click(pass);
    expect(spies.pass).toHaveBeenCalledTimes(1);
  });

  it("renders passes_since_raise, and marks who has passed since the last raise -- still listed, bid standing", () => {
    show(contest(), C);
    expect(container.querySelector('[data-testid="contest-progress-3"]')?.textContent).toBe(
      "1 of 2 passes since the last raise — one more pass and Alice wins at $85.",
    );
    const rows = Array.from(container.querySelectorAll("span")).filter((node) => node.textContent === "PASSED");
    expect(rows).toHaveLength(1);
    expect(rows[0].parentElement?.textContent).toContain("Bob");
    // Every bidder is still on the list with the bid they hold.
    for (const amount of ["$75", "$80", "$85"]) expect(container.textContent).toContain(amount);
  });

  it("a three-bidder contest with no passes yet needs two in a row", () => {
    const state = contest();
    const fresh = {
      ...state,
      waterfall: { ...state.waterfall!, mini_auction: { ...state.waterfall!.mini_auction!, current_turn: B, passes_since_raise: 0 } },
    } as State;
    show(fresh, B);
    expect(container.querySelector('[data-testid="contest-progress-3"]')?.textContent).toBe(
      "0 of 2 passes since the last raise — 2 more passes in a row and Alice wins at $85.",
    );
    expect(button("Pass").title).toContain("You stay in the contest and may raise again");
    expect(Array.from(container.querySelectorAll("span")).filter((node) => node.textContent === "PASSED")).toHaveLength(0);
  });

  it("the sibling cards say the contest sentence the authority refuses them with, not 'not your turn'", () => {
    const state = contest();
    show(state, B); // B is a bidder but not on the cursor; the main sequence is suspended for everyone
    const contestSentence = auctionRefusal(state, state.waterfall ?? null, { WaterfallBuyLowest: { game_id: 0 } });
    expect(contestSentence).toContain("is still being contested");
    const buy = button(/^Buy Schuylkill Valley/);
    expect(buy.disabled).toBe(true);
    expect(buy.title).toBe(contestSentence);
    expect(container.textContent).toContain(contestSentence as string);
    expect(container.textContent).not.toMatch(/not your turn/i);
    const bids = buttons().filter((node) => node.textContent === "Place Bid");
    expect(bids.length).toBe(2);
    for (const bid of bids) {
      expect(bid.disabled).toBe(true);
      expect(bid.title).toBe(contestSentence);
    }
  });

  it("a contest raise is judged by the authority too (the $5 increment over the high bid)", () => {
    const state = contest();
    show(state, C);
    const raise = button("Raise");
    expect(raise.disabled).toBe(false); // defaults to high + $5 = $90; C has $600
    expect(
      auctionRefusal(state, state.waterfall ?? null, { WaterfallMiniAuctionRaise: { game_id: 0, bid_amount: "90" } }),
    ).toBeNull();
    click(raise);
  });
});

/* ================================================================================================================ */
describe("AUD-02.04 (H-04): no double-send -- the dashboard is greyed while a send is in flight", () => {
  it("with sessionReady false every card-face control is disabled and a click sends nothing", () => {
    const state = board({
      privates: [priv(SV_PRIVATE_ID, [], true), priv(2, [[A, 45]]), priv(3), priv(4)],
      currentTurn: A,
    });
    const spies = show(state, A, false);
    // The card-face actions (the special-power "Full Rules" toggles are reading aids, never latched).
    const all = buttons().filter((node) => /^(Buy |Place Bid$|Raise Bid$|Raise$|Pass$)/.test(node.textContent ?? ""));
    expect(all.length).toBe(4); // Buy SV, Raise Bid on the C&StL, Place Bid on the D&H and the M&H
    for (const node of all) expect(node.disabled).toBe(true);
    for (const node of all) click(node);
    expect(spies.buy).not.toHaveBeenCalled();
    expect(spies.bid).not.toHaveBeenCalled();
  });
});

/* ================================================================================================================ */
/* P3-N005: THE DELAYED AUCTION'S SOLVENCY REFUSAL, BEFORE THE CLICK. DA-5's limit board, built by the room engine:
   B (the auction's opener) presides over five corporations in the Normal zone at 50% each -- twenty certificates --
   with every Bank Pool full, so nothing he holds can be sold. Buying the SV or bidding on the C&StL would leave an
   excess no sale in the next Stock Round could cure (D-57/D-58). `cards: 19` is the control that may buy. */

const DA = { A: "p-da5-a01", B: "p-da5-b02", C: "p-da5-c03" };
let serial = 0;
const entry = (actor: string, msg: unknown) =>
  RL.entriesFromExport([{ index: serial, id: `w1b-${serial}`, actor, at: (serial += 1), msg: msg as never }])[0];
const providersFor = (state: State) => ({
  ...sandboxReplayProviders(),
  ...(state.market_positions ? { initialMarket: state.market_positions } : {}),
});
const engineFrom = (state: State): Engine =>
  new RL.RoomEngine(providersFor(state) as never, { state, waterfall: state.waterfall ?? null } as never);
const boardOf = (engine: Engine): State => ({ ...engine.snapshot.state, waterfall: engine.snapshot.waterfall }) as State;
const seatOf = (state: State) => state.player_addresses[state.active_player_index];
const companyOf = (state: State, ticker: string) => state.public_companies.find((company) => company.ticker === ticker)!;
function send(engine: Engine, actor: string, msg: unknown) {
  const now = boardOf(engine);
  expect(turnRefusal({ state: now, waterfall: now.waterfall ?? null, actor, msg: msg as never })).toBeNull();
  engine.apply(entry(actor, msg));
}
const PASS_TURN = { PassTurn: { game_id: 0 } };

function delayedAuctionAtTheLimit(cards: 19 | 20): State {
  const seed = {
    state: withEmptyRoster(SS.sandboxScenarioState(SS.DEFAULT_SANDBOX_SCENARIO, 0, "default")),
    waterfall: waterfallForRoster(
      SS.sandboxWaterfallState(SS.sandboxScenario(SS.DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
      [],
    ),
  };
  const engine = engineFrom({ ...seed.state, waterfall: seed.waterfall } as State);
  engine.apply(
    entry(DA.A, {
      SetupGame: {
        players: [
          { id: DA.A, nickname: "A" },
          { id: DA.B, nickname: "B" },
          { id: DA.C, nickname: "C" },
        ],
        variants: { delayedAuction: true, length: "standard", rules: 1 },
        rules_engine_version: RULES_ENGINE_VERSION,
      },
    }),
  );
  // Stock Round 1: A starts the PRR at $100 (declines to sell, buys, ends the turn); then everybody passes it out.
  send(engine, DA.A, PASS_TURN);
  send(engine, DA.A, {
    BuyStock: { game_id: 0, protocol_id: companyOf(boardOf(engine), "PRR").company_id, source: "Ipo", par_value: "100" },
  });
  send(engine, DA.A, PASS_TURN);
  for (let guard = 0; boardOf(engine).macro_round_number === 1; guard += 1) {
    if (guard > 12) throw new Error("the Stock Round did not end");
    send(engine, seatOf(boardOf(engine)), PASS_TURN);
  }
  const real = boardOf(engine);
  // The end of the Operating Round set that bought the first 3-train (DA-4's hand placement): the NYC under C.
  const nyc = companyOf(real, "NYC");
  const orEnd = {
    ...real,
    current_round_type: "OperatingRound",
    sub_round_index: operatingRoundSequenceLength({ public_companies: [{ company_id: 1, owned_trains: ["3"] }] } as never),
    active_operating_order: [nyc.company_id],
    active_corporation_index: 0,
    active_player_index: real.player_addresses.indexOf(DA.C),
    public_companies: real.public_companies.map((company) =>
      company.company_id === nyc.company_id
        ? {
            ...company,
            is_floated: true,
            president: DA.C,
            par_value: "100",
            owned_trains: ["2", "3"],
            player_holdings: [{ player: DA.C, percentage: 60 }],
            ipo_pool_percentage: 40,
            station_token_hexes: ["G19"],
          }
        : company,
    ),
  } as State;
  const arming = engineFrom(orEnd);
  send(arming, DA.C, PASS_TURN);
  const armed = boardOf(arming);
  expect(armed.current_round_type).toBe("WaterfallAuction");
  // B at the limit: five Normal-zone corporations, 50% each, every Bank Pool full.
  const CORPS = ["CPR", "C&O", "ERIE", "B&M", "NNH"];
  const PRICES = [67, 69, 71, 76, 82];
  let enteredAt = 100;
  const positions: Record<number, unknown> = { ...(armed.market_positions ?? {}) };
  positions[companyOf(armed, "NYC").company_id] = { price: 60, ...marketCellForPrice(60)!, enteredAt: (enteredAt += 1) };
  const companies = armed.public_companies.map((company) => {
    const at = CORPS.indexOf(company.ticker);
    if (at < 0) return company;
    const price = PRICES[at];
    positions[company.company_id] = { price, ...marketCellForPrice(price)!, enteredAt: (enteredAt += 1) };
    const held = cards === 19 && company.ticker === "NNH" ? 40 : 50;
    return {
      ...company,
      is_floated: true,
      par_value: String(price),
      treasury: String(price * 10),
      president: DA.B,
      player_holdings: [{ player: DA.B, percentage: held }],
      bank_pool_percentage: 50,
      ipo_pool_percentage: 50 - held,
    };
  });
  const limited = { ...armed, public_companies: companies, market_positions: positions } as State;
  expect(actingAddress(limited, limited.waterfall ?? null)).toBe(DA.B);
  return limited;
}

describe("P3-N005: the Delayed Auction's solvency refusal shows before the click", () => {
  it("at the limit, Buy and Place Bid are greyed with the authority's sentence; one certificate under, they are live", () => {
    const full = delayedAuctionAtTheLimit(20);
    const waterfall = full.waterfall ?? null;
    expect(auctionActor(waterfall)).toBe(DA.B);
    show(full, DA.B);
    const buyVerdict = auctionRefusal(full, waterfall, { WaterfallBuyLowest: { game_id: 0 } });
    expect(buyVerdict).toContain("no legal sale in the next Stock Round could bring you back");
    const buy = button(/^Buy /);
    expect(buy.disabled).toBe(true);
    expect(buy.title).toBe(buyVerdict);
    expect(container.textContent).toContain(buyVerdict as string);
    // Every bid card is greyed with its own verdict for the amount in its field.
    const bidButtons = buttons().filter((node) => node.textContent === "Place Bid");
    expect(bidButtons.length).toBeGreaterThan(0);
    for (const node of bidButtons) {
      expect(node.disabled).toBe(true);
      expect(node.title).toContain("over the limit");
    }

    const under = delayedAuctionAtTheLimit(19);
    show(under, DA.B);
    expect(auctionRefusal(under, under.waterfall ?? null, { WaterfallBuyLowest: { game_id: 0 } })).toBeNull();
    expect(button(/^Buy /).disabled).toBe(false);
    expect(accepted(under, DA.B, { WaterfallBuyLowest: { game_id: 0 } })).toBe(true);
  });
});
