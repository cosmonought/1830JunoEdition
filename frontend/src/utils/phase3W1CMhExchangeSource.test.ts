/** @jest-environment node */
//
// ==================================================================
//  PHASE 3 W1-C (AUD-10.02 / AUD-10.04): THE M&H EXCHANGE READS THE AUTHORITY, AND THE OWNER PICKS THE PILE
// ==================================================================
//
// U-35 (i/ii): the shell used a client-side copy of the M&H rule (`resolvePrivateExchange`: flat 60% cap, no
// Orange/Brown waiver, no certificate-limit check, IPO silently first). K-03: the owner ruled the choice between
// the IPO and the Bank Pool REQUIRED. This suite proves, by CALLING the shell's helpers on realistic boards:
//
//   1. the per-pile verdict is `mhExchangeRequestRefusal`'s, byte for byte -- no second rule;
//   2. the Orange/Brown 60% waiver and the certificate limit are honoured (both were missing before);
//   3. the flow offers both piles when both are legal, only the legal one otherwise, none when neither is;
//   4. through a ROOM (the server path), the pile the player chose is the pile the certificate leaves;
//   5. the shell's dispatch sends `request.source` and has no resolver or preference of its own.

import { mhExchangeRequestRefusal } from "../gameEngine/mohawkExchange";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { CURRENT_RULES_REVISION } from "../gameEngine/gameVariants";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import { cellAt } from "../components/marketChart";
import type { GameStateResponse } from "../gameEngine/gameState";
import {
  deriveActivePowerFlow,
  MH_EXCHANGE_SOURCES,
  mhExchangeRequestFor,
  mhExchangeSourceOptions,
} from "./activePrivatePower";
import { exchangeSourceForStep } from "./privatePowerFlow";
import { roomFor } from "./offerMatrix74Support";
import { readShell, sliceBetween } from "./sourceScan";

const P1 = "p1";
const P2 = "p2";
const P3 = "p3";
const PRR = 1;
const NYC = 2;
const BO = 4;

function cell(x: number, y: number) {
  const found = cellAt(x, y);
  if (!found) throw new Error(`no chart cell at (${x}, ${y})`);
  return { x, y, price: found.price };
}
/** A Normal-zone $100 cell (the cap holds) and an Orange-zone cell (the cap is lifted), from the chart in effect. */
const NORMAL = cell(9, 7);
const ORANGE = cell(0, 6);

interface Corp {
  id: number;
  ticker: string;
  president: string | null;
  at?: { x: number; y: number };
  ipo?: number;
  pool?: number;
  holdings?: Array<[string, number]>;
  floated?: boolean;
}

/** A Stock Round board, P1 seated and owning the M&H, with a real chart position for every corporation so the
 *  zone rules the authority reads (`chartContextFromState`) are the chart's, not a fixture's opinion. */
function board(corps: Corp[], extraPrivates: number = 0, over: Partial<GameStateResponse> = {}): GameStateResponse {
  const players = [P1, P2, P3];
  return {
    game_id: 1,
    variants: { rules: CURRENT_RULES_REVISION },
    rules_engine_version: RULES_ENGINE_VERSION,
    player_addresses: players,
    player_cash: players.map((player) => ({ player, cash_vgp: "500" })),
    virtual_bank_vgp: "10000",
    private_companies: [
      { private_id: MH_PRIVATE_ID, name: "Mohawk & Hudson", cost: "110", revenue_per_or: "20", owner: P1, owner_protocol_id: null, closed: false },
      ...Array.from({ length: extraPrivates }, (_, n) => ({
        private_id: 10 + n,
        name: `Filler ${n}`,
        cost: "10",
        revenue_per_or: "0",
        owner: P1,
        owner_protocol_id: null,
        closed: false,
      })),
    ],
    current_round_type: "StockRound",
    macro_round_number: 3,
    active_player_index: 0,
    priority_deal_index: 0,
    last_trader_index: null,
    consecutive_passes: 0,
    active_operating_order: [],
    active_corporation_index: 0,
    sub_round_index: 0,
    operating_round_sequence_length: 1,
    operating_round_just_ended: false,
    stock_round_just_ended: false,
    current_global_era: "Yellow",
    bought_this_turn: 0,
    turn_action_taken: false,
    market_positions: Object.fromEntries(
      corps.map((corp, n) => {
        const where = corp.at ?? NORMAL;
        return [corp.id, { ...cell(where.x, where.y), enteredAt: n + 1 }];
      }),
    ),
    public_companies: corps.map((corp) => ({
      company_id: corp.id,
      ticker: corp.ticker,
      is_floated: corp.floated ?? true,
      president: corp.president,
      par_value: "100",
      ipo_pool_percentage: corp.ipo ?? 0,
      bank_pool_percentage: corp.pool ?? 0,
      treasury: "300",
      owned_trains: [],
      player_holdings: (corp.holdings ?? []).map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [],
      station_tokens: [],
      station_token_limit: 3,
      home_hex_label: null,
      last_route_revenue: "0",
    })),
    ...over,
  } as unknown as GameStateResponse;
}

const nyc = (over: Partial<Corp> = {}): Corp => ({
  id: NYC,
  ticker: "NYC",
  president: P2,
  ipo: 30,
  pool: 20,
  holdings: [[P2, 50]],
  ...over,
});

const verdicts = (state: GameStateResponse, viewer = P1) =>
  Object.fromEntries(mhExchangeSourceOptions(state, viewer, MH_PRIVATE_ID).map((o) => [o.source, o.refusal]));

const flowFor = (state: GameStateResponse, viewer = P1) =>
  deriveActivePowerFlow({
    state,
    request: "mh-exchange",
    usedAbilities: new Set<string>(),
    dhStationForfeited: false,
    dhForfeited: false,
    actingProtocolId: null,
    viewerAddress: viewer,
    dhPrivateId: 3,
    cslPrivateId: 2,
    mhPrivateId: MH_PRIVATE_ID,
  });

const corpOf = (state: GameStateResponse, id: number) => state.public_companies.find((c) => c.company_id === id)!;
const piles = (state: GameStateResponse) => [corpOf(state, NYC).ipo_pool_percentage, corpOf(state, NYC).bank_pool_percentage];

describe("1. one rule: the shell's per-pile verdict IS the authority's (AUD-10.02)", () => {
  const boards: Array<[string, GameStateResponse]> = [
    ["both piles", board([nyc()])],
    ["IPO only", board([nyc({ ipo: 50, pool: 0 })])],
    ["pool only", board([nyc({ ipo: 0, pool: 50, holdings: [[P2, 50]] })])],
    ["neither", board([nyc({ ipo: 0, pool: 0, holdings: [[P2, 100]] })])],
    ["at the cap, Normal zone", board([nyc({ president: P1, holdings: [[P1, 60]], ipo: 20, pool: 20 })])],
    ["at the cap, Orange zone", board([nyc({ president: P1, holdings: [[P1, 60]], ipo: 20, pool: 20, at: ORANGE })])],
    ["a request already pending", board([nyc()], 0, { pending_mh_exchange: { player: P1, private_id: MH_PRIVATE_ID, company_id: NYC, source: "Ipo" } } as Partial<GameStateResponse>)],
  ];

  it.each(boards)("%s", (_name, state) => {
    for (const source of MH_EXCHANGE_SOURCES) {
      const authority = mhExchangeRequestRefusal(
        state,
        { private_id: MH_PRIVATE_ID, company_id: NYC, player: P1, source },
        P1,
      );
      expect(verdicts(state)[source]).toBe(authority);
    }
  });

  it("a viewer who does not own the M&H gets the authority's ownership refusal for both piles", () => {
    const state = board([nyc()]);
    expect(verdicts(state, P2)).toEqual({
      Ipo: "The Mohawk & Hudson is not yours to exchange.",
      Bank: "The Mohawk & Hudson is not yours to exchange.",
    });
  });
});

describe("2. the rules the old copy missed are honoured", () => {
  it("the Orange/Brown 60% waiver: refused at 60% in a Normal zone, legal at 60% in the Orange zone", () => {
    const normal = board([nyc({ president: P1, holdings: [[P1, 60]], ipo: 20, pool: 20 })]);
    const orange = board([nyc({ president: P1, holdings: [[P1, 60]], ipo: 20, pool: 20, at: ORANGE })]);
    expect(verdicts(normal).Ipo).toMatch(/no player may exceed 60%/);
    expect(verdicts(normal).Bank).toMatch(/no player may exceed 60%/);
    expect(verdicts(orange)).toEqual({ Ipo: null, Bank: null });
    // And the flow follows: nothing offered on the Normal board, both piles on the Orange one.
    expect(flowFor(normal)!.steps).toEqual([]);
    expect(flowFor(normal)!.unavailable).toMatch(/no player may exceed 60%/);
    expect(flowFor(orange)!.steps.map((s) => s.key)).toEqual(["exchange-ipo", "exchange-bank"]);
  });

  it("the certificate limit: a player who would end over it is refused, and nothing is offered", () => {
    /* Three players -> a limit of 20. P1: 9 PRR cards (20% + eight 10%) + 4 B&O cards + the M&H + 7 fillers = 21,
       already over; the exchange replaces one card with one card and cannot bring P1 back within it. */
    const over = board(
      [
        { id: PRR, ticker: "PRR", president: P1, at: cell(10, 7), ipo: 0, holdings: [[P1, 100]] },
        { id: BO, ticker: "B&O", president: P3, at: cell(7, 8), ipo: 0, holdings: [[P3, 60], [P1, 40]] },
        nyc(),
      ],
      7,
    );
    expect(verdicts(over).Ipo).toMatch(/against a limit of 20/);
    expect(verdicts(over).Bank).toMatch(/against a limit of 20/);
    expect(flowFor(over)!.steps).toEqual([]);
    // The SAME board one filler lighter sits exactly ON the limit -- a one-for-one swap is legal (#1630a).
    const onLimit = board(
      [
        { id: PRR, ticker: "PRR", president: P1, at: cell(10, 7), ipo: 0, holdings: [[P1, 100]] },
        { id: BO, ticker: "B&O", president: P3, at: cell(7, 8), ipo: 0, holdings: [[P3, 60], [P1, 40]] },
        nyc(),
      ],
      6,
    );
    expect(verdicts(onLimit)).toEqual({ Ipo: null, Bank: null });
  });
});

describe("3. the flow offers exactly the legal piles, with no silent preference (AUD-10.04)", () => {
  it.each([
    ["both legal", nyc(), ["exchange-ipo", "exchange-bank"]],
    ["IPO only", nyc({ ipo: 50, pool: 0 }), ["exchange-ipo"]],
    ["pool only", nyc({ ipo: 0, pool: 50 }), ["exchange-bank"]],
    ["neither", nyc({ ipo: 0, pool: 0, holdings: [[P2, 100]] }), []],
  ] as const)("%s", (_name, corp, keys) => {
    const flow = flowFor(board([corp]))!;
    expect(flow.steps.map((step) => step.key)).toEqual(keys);
    // Every offered step is live: nothing is preselected and nothing is greyed in favour of the other pile.
    expect(flow.steps.every((step) => step.enabled && !step.done)).toBe(true);
  });
});

describe("4. through a room, the chosen pile is the pile the certificate leaves", () => {
  /* The shell's message body is `{ private_id, company_id, player, source }` taken field for field from
     `mhExchangeRequestFor`'s request (pinned in section 5). Submitting that request to a RoomSession is the
     server path the dispatch reaches. */
  it.each([
    ["Ipo", [20, 20]],
    ["Bank", [30, 10]],
  ] as const)("chose %s on a board where both are legal", (source, expected) => {
    const seed = board([nyc()]);
    const flow = flowFor(seed)!;
    const step = flow.steps.find((s) => exchangeSourceForStep(s.key) === source)!;
    expect(step).toBeDefined();
    const outcome = mhExchangeRequestFor(seed, P1, MH_PRIVATE_ID, exchangeSourceForStep(step.key)!);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.request.source).toBe(source);

    const { room, submit } = roomFor(seed);
    submit(P1, { ExchangePrivate: { game_id: 1, ...outcome.request } });
    const after = room.state;
    expect(piles(after)).toEqual(expected);
    expect(after.private_companies.find((p) => p.private_id === MH_PRIVATE_ID)!.closed).toBe(true);
    expect(corpOf(after, NYC).player_holdings).toContainEqual({ player: P1, percentage: 10 });
  });
});

describe("5. the shell dispatches the chosen pile and nothing else (source pins)", () => {
  const APP = readShell();

  it("asks the authority per pile and sends `request.source`", () => {
    const body = sliceBetween(APP, "const runPrivateExchange = useCallback(", "const handlePowerFlowAct");
    expect(body).toContain("(source: ExchangeSource, actionLabel: string): boolean =>");
    expect(body).toContain("mhExchangeRequestFor(");
    expect(body).toContain("source: request.source,");
    expect(body).not.toContain('"Ipo"');
    expect(body).not.toContain('"Bank"');
  });

  it("the retired client-side resolver is no longer called by the shell", () => {
    expect(APP).not.toContain("resolvePrivateExchange(");
  });

  it("the act handler reads the pile from the pressed step", () => {
    const body = sliceBetween(APP, "const handlePowerFlowAct", "const handlePowerFlowDecline");
    expect(body).toContain("const exchangeSource = exchangeSourceForStep(step);");
    expect(body).toContain("runPrivateExchange(exchangeSource,");
  });
});
