/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-D: THE M&H REQUEST OFF-TURN AND IN THE OPERATING ROUND; THE JK CHIP
// ==================================================================
//
// Rows: AUD-10.05 (K-04) -- the M&H owner can raise the exchange request in an Operating Round; P3-N003 (M1) -- the
// M&H chip is not turn-gated; AUD-04.03 (A-8) -- the JK chip only in an Operating Round's Lay Track step, and its arm
// never survives the OR. Plus the plan's surface: the chip's hold is the authority's refusal of `ExchangePrivate`.
//
// PRESENTATION ONLY. The engine already answers every rule here (`mohawkExchange.ts`: the SR+OR window, own-SR-turn
// executes / everything else queues, holds refuse rather than queue, one pending request). These tests CALL the pure
// helpers, RUN the real reducer and RENDER the real bar; the App source pins at the end are wiring checks only.
//
//   1. the offer: OR admitted and `offTurn`; the old exclusions unchanged;
//   2. the round trip: an off-turn OR owner's request is legal by the authority and the reducer QUEUES it;
//   3. the hold: `dockHoldView(...).exchangePrivate` per hold; null while scrubbing; pending > hold > live;
//   4. the rendered bar: the off-turn chip shows and is live on `offTurnPowerReady`; corporate chips stay hidden;
//   5. JK: `jkPowerOfferFor` only in OR Track; `jkArmScope` moves with the round's identity;
//   6. App wiring pins.

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "../panels/ContextualActionBar";
import type { SandboxLogMsg } from "../gameEngine/gameSetup";
import type { GameStateResponse } from "../gameEngine/gameState";
import { resolveVariants } from "../gameEngine/gameVariants";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { JK_TILE_ABILITY_KEY } from "../gameEngine/kanawhaLicense";
import { JK_PRIVATE_ID } from "../gameEngine/levelPlayingField";
import { MH_PRIVATE_ID } from "../gameEngine/privateExchange";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import type { OperatingSubPhase } from "../components/OperatingSubPhaseStepper";
import { jkArmScope, jkPowerOfferFor, mhExchangeRequestFor, stockRoundExchangeOffers } from "./activePrivatePower";
import { dockHoldView } from "./dockHoldView";
import { pendingMhExchangeView, withPendingMhExchangeChip } from "./mhQueuedExchange";
import { CA, DH, MH, operatingBoard, stockRoundBoard } from "./offerFixtures74";
import { apply, corridor, fundingBoard, GRID, M, NYC, P1, P2, P3, PRR, CO, withCorp, withState } from "./offerMatrix74Support";
import { readShell, sliceBetween } from "./sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const NAMES: Record<string, string> = { [P1]: "Ann", [P2]: "Ben", [P3]: "Cy" };
const labelFor = (address: string) => NAMES[address] ?? address;
const SANDBOX = { sandbox: true, mhPrivateId: MH_PRIVATE_ID } as const;

/* The fixtures' M&H id is the engine's. Asserted, not assumed: every board below hands `MH` to the reducer and
   `MH_PRIVATE_ID` to the helpers. */
it("the fixture's M&H is the engine's M&H", () => {
  expect(MH).toBe(MH_PRIVATE_ID);
});

/* PRR (Ann) operating at Lay Track; NYC (Ben) with 30% in the IPO; the M&H is BEN's -- an owner who is NOT the acting
   president, which is the seat this slice is about. Current rules version, so the board is one the room deals. */
const orBoard = (step = "Track") =>
  withState(
    operatingBoard({
      step,
      corps: [
        { id: PRR, ticker: "PRR", president: P1, trains: ["2"], treasury: "500" },
        { id: NYC, ticker: "NYC", president: P2, trains: ["2"], treasury: "400", price: 90, ipo: 30, holdings: [[P2, 40], [P3, 20]] },
        { id: CO, ticker: "C&O", president: P3, trains: ["2"], treasury: "300", price: 80 },
      ],
      privates: [
        { id: MH, owner: P2, cost: "110" },
        { id: DH, owner: P1, cost: "70" },
        { id: CA, owner: P3, cost: "160" },
      ],
    }),
    { rules_engine_version: RULES_ENGINE_VERSION },
  );

const nycHeldBy = (state: GameStateResponse, player: string) =>
  state.public_companies.find((c) => c.company_id === NYC)!.player_holdings.find((h) => h.player === player)?.percentage ?? 0;
const mhOf = (state: GameStateResponse) => state.private_companies.find((p) => p.private_id === MH)!;

/* ================================================================== 1 ================================================================== */

describe("1. the M&H request is offered in the Operating Round, off-turn (AUD-10.05, P3-N003)", () => {
  it("offers it to the owning player in an Operating Round, marked offTurn", () => {
    const offers = stockRoundExchangeOffers({ state: orBoard(), viewerAddress: P2, ...SANDBOX });
    expect(offers).toHaveLength(1);
    expect(offers[0].abilityKey).toBe("mh-exchange");
    expect(offers[0].offTurn).toBe(true);
    /* Copy unchanged: the chip raises the question, it does not perform the exchange. */
    expect(offers[0].chipLabel).toBe("Exchange MH for NYC");
    expect(offers[0].chipTitle).toContain("nothing is spent until you answer it");
  });

  it("still offers it in a Stock Round, marked offTurn there too", () => {
    const sr = stockRoundBoard();
    const offers = stockRoundExchangeOffers({ state: sr, viewerAddress: P1, ...SANDBOX });
    expect(offers.map((o) => [o.abilityKey, o.offTurn])).toEqual([["mh-exchange", true]]);
  });

  it("keeps every exclusion: auction, finished game, non-owner, corporation-owned, closed, non-sandbox", () => {
    const base = orBoard();
    expect(stockRoundExchangeOffers({ state: withState(base, { current_round_type: "WaterfallAuction" }), viewerAddress: P2, ...SANDBOX })).toEqual([]);
    expect(stockRoundExchangeOffers({ state: withState(base, { current_round_type: "GameEnd" }), viewerAddress: P2, ...SANDBOX })).toEqual([]);
    expect(stockRoundExchangeOffers({ state: base, viewerAddress: P1, ...SANDBOX })).toEqual([]);
    expect(stockRoundExchangeOffers({ state: base, viewerAddress: P3, ...SANDBOX })).toEqual([]);
    const corpOwned = {
      ...base,
      private_companies: base.private_companies.map((p) => (p.private_id === MH ? { ...p, owner: null, owner_protocol_id: PRR } : p)),
    } as GameStateResponse;
    expect(stockRoundExchangeOffers({ state: corpOwned, viewerAddress: P2, ...SANDBOX })).toEqual([]);
    const closed = {
      ...base,
      private_companies: base.private_companies.map((p) => (p.private_id === MH ? { ...p, closed: true } : p)),
    } as GameStateResponse;
    expect(stockRoundExchangeOffers({ state: closed, viewerAddress: P2, ...SANDBOX })).toEqual([]);
    expect(stockRoundExchangeOffers({ state: base, viewerAddress: P2, sandbox: false, mhPrivateId: MH_PRIVATE_ID })).toEqual([]);
    expect(stockRoundExchangeOffers({ state: null, viewerAddress: P2, ...SANDBOX })).toEqual([]);
  });
});

/* ================================================================== 2 ================================================================== */

describe("2. off-turn in the Operating Round, the authority and the reducer agree: the request QUEUES", () => {
  it("is legal by the authority for the non-acting owner, and the real reducer queues it without moving a share", () => {
    const before = orBoard();
    const acting = before.public_companies.find((c) => c.company_id === before.active_operating_order[before.active_corporation_index])!;
    expect(acting.president).toBe(P1); // Ann operates; Ben owns the M&H
    const outcome = mhExchangeRequestFor(before, P2, MH_PRIVATE_ID, "Ipo");
    expect(outcome).toEqual({ ok: true, request: { private_id: MH, company_id: NYC, player: P2, source: "Ipo" } });
    if (!outcome.ok) throw new Error("unreachable");

    const after = apply(before, { ExchangePrivate: { game_id: 1, ...outcome.request } }, P2);
    expect(after.pending_mh_exchange).toEqual(expect.objectContaining({ private_id: MH, player: P2, source: "Ipo" }));
    /* Queuing vests nothing (D-29): no share moved, the private is still open and still Ben's. */
    expect(nycHeldBy(after, P2)).toBe(nycHeldBy(before, P2));
    expect(after.public_companies.find((c) => c.company_id === NYC)!.ipo_pool_percentage).toBe(30);
    expect(mhOf(after).closed).toBe(false);
    expect(mhOf(after).owner).toBe(P2);
    /* And the chip, on that board, reads pending (W2-E) -- the offer still exists, relabelled and greyed. */
    const chip = withPendingMhExchangeChip(
      stockRoundExchangeOffers({ state: after, viewerAddress: P2, ...SANDBOX }),
      pendingMhExchangeView(after, labelFor),
    );
    expect(chip).toHaveLength(1);
    expect(chip[0].blockedReason).toMatch(/^Ben has requested to exchange/);
  });
});

/* ================================================================== 3 ================================================================== */

const EXCHANGE_PROBE = { ExchangePrivate: { game_id: 1, private_id: MH, company_id: NYC, player: P2, source: "Ipo" } } as unknown as SandboxLogMsg;

describe("3. the chip's hold is the authority's refusal of ExchangePrivate (dockHold.exchangePrivate)", () => {
  const view = (state: GameStateResponse, grid = GRID, scrubbing = false) =>
    dockHoldView({ state, mapGrid: grid, homeHexToAxial: boardHomeHexToAxial, labelFor, scrubbing });

  const DISCARD_OWED = () =>
    withCorp(withCorp(orBoard(), PRR, { owned_trains: ["4"] }), CO, { owned_trains: ["3", "3", "3", "3"] });
  const FORCED = () => fundingBoard(100, { privates: [{ id: MH, owner: P2, cost: "110" }] });
  const ENDED = () => withState(orBoard(), { current_round_type: "GameEnd" });
  const TRAIN_OFFERED = () => apply(orBoard("Hardware"), M.proposeTrain(NYC, PRR, "2", "150"), P1);
  /* A private purchase needs phase 3 -- the 3-train on PRR puts the board there, as W2-A's matrix board is. */
  const PRIVATE_OFFERED = () =>
    apply(
      withState(withCorp(orBoard("Hardware"), PRR, { owned_trains: ["3"] }), { current_global_era: "Green" }),
      M.proposePrivate(CA, PRR, 100),
      P1,
    );
  const TRADE_OFFERED = () =>
    apply(
      stockRoundBoard({ privates: [{ id: DH, owner: P2, cost: "70" }, { id: MH, owner: P1, cost: "110" }] }),
      M.proposeTrade(DH, P2, P1, 50),
      P1,
    );
  const HOME_OWED = () => withCorp(orBoard(), PRR, { home_hex_label: "H12", station_token_hexes: [], station_tokens: [] });

  it("is null with no hold", () => {
    expect(view(orBoard()).exchangePrivate).toBeNull();
    expect(view(stockRoundBoard()).exchangePrivate).toBeNull();
  });

  const HELD: Array<[string, () => GameStateResponse, ReturnType<typeof corridor> | typeof GRID, RegExp]> = [
    ["the excess-train discard", DISCARD_OWED, GRID, /must discard before anything else happens\.$/],
    ["the forced purchase / funding hold", FORCED, corridor(), /its president must fund the purchase before anything else happens\.$/],
    ["the finished game", ENDED, GRID, /^The game has ended\. Nothing further can be played\.$/],
    ["a standing train offer", TRAIN_OFFERED, GRID, /^PRR's offer of \$150 for NYC's 2-train is waiting for the selling president's answer/],
    ["a standing private purchase offer", PRIVATE_OFFERED, GRID, /^PRR's offer of \$100 for .* is waiting for its owner's answer/],
    ["a standing player trade offer", TRADE_OFFERED, GRID, /between Ben and Ann for \$50 and is waiting for an answer/],
    ["the home-station hold", HOME_OWED, GRID, /^PRR is starting its first operating turn and its home station is not on the board yet\./],
  ];

  it.each(HELD)("greys it with the authority's sentence under %s", (_label, board, grid, sentence) => {
    const state = board();
    const held = view(state, grid).exchangePrivate;
    expect(held).toMatch(sentence);
    /* NAMES, never seat ids, as every dock field reads. */
    expect(held).not.toMatch(/\bp[123]\b/);
    /* The same hold every other refused control on this board reads -- one hold answer, not a second rule. */
    expect(held).toBe(view(state, grid).pass);
  });

  it("is null while scrubbing, whatever stands", () => {
    for (const [, board, grid] of HELD) expect(view(board(), grid, true).exchangePrivate).toBeNull();
  });

  it("the hold REFUSES the request rather than queueing it (the reducer agrees with the grey chip)", () => {
    const state = TRAIN_OFFERED();
    expect(view(state).exchangePrivate).not.toBeNull();
    const after = apply(state, EXCHANGE_PROBE, P2);
    expect(after.pending_mh_exchange ?? null).toBeNull();
  });

  it("composes pending > hold > live, as the shell does", () => {
    /* The shell's composition, step for step: the offer, greyed by `dockHold.exchangePrivate`, then relabelled by
       the pending view (applied last). Asked of real boards. */
    const compose = (state: GameStateResponse) => {
      const offers = stockRoundExchangeOffers({ state, viewerAddress: P2, ...SANDBOX });
      const hold = view(state).exchangePrivate;
      const held = hold === null ? offers : offers.map((offer) => ({ ...offer, blockedReason: hold }));
      return withPendingMhExchangeChip(held, pendingMhExchangeView(state, labelFor));
    };
    /* live */
    const live = compose(orBoard());
    expect(live.map((c) => c.blockedReason ?? null)).toEqual([null]);
    /* hold */
    const queued = apply(orBoard("Hardware"), EXCHANGE_PROBE, P2);
    expect(queued.pending_mh_exchange).not.toBeNull();
    const heldOnly = compose(TRAIN_OFFERED());
    expect(heldOnly[0].blockedReason).toMatch(/waiting for the selling president's answer/);
    /* pending AND a hold on the same board: pending wins */
    const both = apply(queued, M.proposeTrain(NYC, PRR, "2", "150"), P1);
    expect(view(both).exchangePrivate).toMatch(/waiting for the selling president's answer/);
    expect(both.pending_mh_exchange).not.toBeNull();
    const chip = compose(both);
    expect(chip[0].chipLabel).toBe(pendingMhExchangeView(both, labelFor)!.chipLabel);
    expect(chip[0].blockedReason).toBe(pendingMhExchangeView(both, labelFor)!.sentence);
  });
});

/* ================================================================== 4 ================================================================== */

type Props = ComponentProps<typeof ContextualActionBar>;
const noop = () => undefined;

const MH_OFFER = stockRoundExchangeOffers({ state: orBoard(), viewerAddress: P2, ...SANDBOX })[0];
const HEX_OFFERS = [
  { abilityKey: "dh-tile", chipLabel: "Use DH Power", chipTitle: "Opens the question the hex asks." },
  { abilityKey: "csl-tile", chipLabel: "Use CSL Power", chipTitle: "Opens the question the hex asks." },
  { abilityKey: JK_TILE_ABILITY_KEY, chipLabel: "Use JK Power", chipTitle: "Close the JK." },
];

function barProps(over: Partial<Props> = {}): Props {
  return {
    roundType: "OperatingRound",
    orSubPhase: "Track",
    sessionReady: false,
    offTurnPowerReady: true,
    isMyTurn: false,
    onPassTurn: noop,
    passDisabledReason: null,
    turnHoldReason: null,
    onPlaceStationTokenHint: noop,
    stationTokenCost: 40,
    activeCorporation: null,
    onSkipSubPhase: noop,
    onOpenPrivateTrade: noop,
    ownsAnyTrain: false,
    mustBuyTrain: false,
    activePlayerName: "Ann",
    activePlayerCash: 300,
    activePlayerEscrow: 0,
    privateCompanies: [],
    onRunTrains: noop,
    onPayDividends: noop,
    onWithholdRevenue: noop,
    dividendRevenue: 0,
    dividendRevenueIsThisTurn: false,
    dividendPerShare: 0,
    dividendPayouts: [],
    rustOutlookForBar: null,
    dividendPrice: null,
    payProjection: null,
    withholdProjection: null,
    selectedHardwareModel: "2",
    onEndOperatingTurn: noop,
    onUndoLastAction: noop,
    onAutoRoute: noop,
    onSelectRouteTrain: noop,
    highlightedRouteIndex: null,
    onHighlightRoute: noop,
    trainDrafts: [],
    activeTrainIndex: 0,
    routeFeedback: null,
    onClearRoute: noop,
    currentGlobalEra: null,
    maxRouteRevenue: 0,
    powerOffers: [...HEX_OFFERS, MH_OFFER],
    onUsePowerOffer: noop,
    ...over,
  } as Props;
}

describe("4. the rendered bar: the M&H chip alone is shown and live off-turn", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = (props: Props) => act(() => root.render(<ContextualActionBar {...props} />));
  const text = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const chips = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter((b) => text(b) === label);
  const mhChip = () => {
    const found = chips("Exchange MH for NYC");
    expect(found).toHaveLength(1);
    return found[0];
  };

  it("Operating Round, viewer off-turn: the M&H chip renders and is enabled; D&H / C&SL / JK do not render", () => {
    render(barProps());
    expect(mhChip().disabled).toBe(false);
    expect(mhChip().title).toContain("nothing is spent until you answer it");
    for (const hex of HEX_OFFERS) expect(chips(hex.chipLabel)).toHaveLength(0);
  });

  it("the acting seat still sees the corporate chips (ordinary chips unchanged)", () => {
    render(barProps({ isMyTurn: true, sessionReady: true }));
    for (const hex of HEX_OFFERS) {
      const found = chips(hex.chipLabel);
      expect(found).toHaveLength(1);
      expect(found[0].disabled).toBe(false);
    }
    expect(mhChip().disabled).toBe(false);
  });

  it("an ordinary chip on the acting seat still waits for sessionReady; the M&H chip does not", () => {
    render(barProps({ isMyTurn: true, sessionReady: false, offTurnPowerReady: true }));
    for (const hex of HEX_OFFERS) expect(chips(hex.chipLabel)[0].disabled).toBe(true);
    expect(mhChip().disabled).toBe(false);
  });

  it("offTurnPowerReady = false disables the M&H chip", () => {
    render(barProps({ offTurnPowerReady: false }));
    expect(mhChip().disabled).toBe(true);
  });

  it("Stock Round, viewer off-turn: the M&H chip is enabled (P3-N003)", () => {
    render(barProps({ roundType: "StockRound", powerOffers: [MH_OFFER] }));
    expect(mhChip().disabled).toBe(false);
  });

  it("a blockedReason greys it and the title is the authoritative sentence", () => {
    const sentence = dockHoldView({ state: apply(orBoard("Hardware"), M.proposeTrain(NYC, PRR, "2", "150"), P1), mapGrid: GRID, labelFor })
      .exchangePrivate!;
    expect(sentence).not.toBeNull();
    render(barProps({ powerOffers: [{ ...MH_OFFER, blockedReason: sentence }] }));
    expect(mhChip().disabled).toBe(true);
    expect(mhChip().title).toBe(sentence);
  });

  it("a queued request's pending chip still reaches the off-turn OR owner, greyed with the request's sentence", () => {
    /* Review follow-up: W2-E's relabel must keep the offer's `offTurn`, or the bar would filter the pending chip
       out for exactly the seat that queued it. Built from a real queued board, through the real composition. */
    const queued = apply(orBoard("Hardware"), EXCHANGE_PROBE, P2);
    const view = pendingMhExchangeView(queued, labelFor)!;
    expect(view).not.toBeNull();
    const pending = withPendingMhExchangeChip(stockRoundExchangeOffers({ state: queued, viewerAddress: P2, ...SANDBOX }), view);
    render(barProps({ powerOffers: [...HEX_OFFERS, ...pending] }));
    const found = chips(view.chipLabel);
    expect(found).toHaveLength(1);
    expect(found[0].disabled).toBe(true);
    expect(found[0].title).toBe(view.sentence);
    for (const hex of HEX_OFFERS) expect(chips(hex.chipLabel)).toHaveLength(0);
  });

  it("Pass Turn stays disabled when sessionReady is false, whatever offTurnPowerReady says", () => {
    render(barProps({ roundType: "StockRound", powerOffers: [MH_OFFER], offTurnPowerReady: true, sessionReady: false }));
    const pass = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="pass-turn-button"]'));
    expect(pass).toHaveLength(1);
    expect(pass[0].disabled).toBe(true);
    expect(mhChip().disabled).toBe(false);
  });
});

/* ================================================================== 5 ================================================================== */

describe("5. the JK chip lives in one Operating Round's Lay Track step (AUD-04.03 / A-8)", () => {
  const LPF = resolveVariants({ levelPlayingField: true });
  const jkBoard = (over: Record<string, unknown> = {}) =>
    withState(
      operatingBoard({
        step: "Track",
        privates: [{ id: JK_PRIVATE_ID, owner: null, ownerCorp: PRR, cost: "120" }],
      }),
      { variants: LPF, ...over },
    );
  const offer = (state: GameStateResponse, orSubPhase: OperatingSubPhase = "Track", armed = false, acting: number | null = PRR) =>
    jkPowerOfferFor({ state, actingProtocolId: acting, orSubPhase, armed });

  it("is present in OR Track for the owning corporation, copy unchanged", () => {
    expect(offer(jkBoard())).toEqual({
      abilityKey: JK_TILE_ABILITY_KEY,
      chipLabel: "Use JK Power",
      chipTitle:
        "Close the JK to lay one tile on a hex beside Coal River (L8) at half its terrain cost. Uses this turn's tile lay.",
    });
    expect(offer(jkBoard(), "Track", true)?.chipLabel).toBe("JK armed — lay beside Coal River");
  });

  it("is null in a Stock Round even with a stale / fallback Track sub-phase and the old acting corporation", () => {
    const sr = jkBoard({ current_round_type: "StockRound", operating_sub_phase: "Track" });
    expect(offer(sr, "Track", false, PRR)).toBeNull();
    expect(offer(sr, "Track", true, PRR)).toBeNull();
    expect(offer(jkBoard({ current_round_type: "WaterfallAuction" }))).toBeNull();
    expect(offer(jkBoard({ current_round_type: "GameEnd" }))).toBeNull();
  });

  it("is null outside Track", () => {
    for (const step of ["BuyPrivate", "Tokens", "Routes", "Dividends", "Hardware"] as OperatingSubPhase[]) {
      expect(offer(jkBoard(), step)).toBeNull();
    }
  });

  it("is null for a corporation that does not own it, when spent, closed, or without the variant", () => {
    expect(offer(jkBoard(), "Track", false, NYC)).toBeNull();
    expect(offer(jkBoard(), "Track", false, null)).toBeNull();
    expect(offer(jkBoard({ used_private_abilities: [JK_TILE_ABILITY_KEY] }))).toBeNull();
    const closed = jkBoard();
    expect(
      offer({ ...closed, private_companies: closed.private_companies.map((p) => ({ ...p, closed: true })) } as GameStateResponse),
    ).toBeNull();
    expect(offer(withState(jkBoard(), { variants: resolveVariants({}) }))).toBeNull();
  });

  it("jkArmScope changes across OR -> SR, macro round, sub-round, acting corporation and sub-phase", () => {
    const base = jkBoard({ macro_round_number: 3, sub_round_index: 1 });
    const key = jkArmScope(base, PRR, "Track");
    expect(jkArmScope(base, PRR, "Track")).toBe(key); // stable on the same moment
    /* OR -> SR, with the cursor (corporation + step) left exactly where the OR ended (#1235). */
    expect(jkArmScope(withState(base, { current_round_type: "StockRound" }), PRR, "Track")).not.toBe(key);
    /* OR -> a later OR of the next macro round, same corporation and step on the cursor. */
    expect(jkArmScope(withState(base, { macro_round_number: 4 }), PRR, "Track")).not.toBe(key);
    /* OR -> the next OR of the same macro round. */
    expect(jkArmScope(withState(base, { sub_round_index: 2 }), PRR, "Track")).not.toBe(key);
    expect(jkArmScope(base, NYC, "Track")).not.toBe(key);
    expect(jkArmScope(base, PRR, "Tokens")).not.toBe(key);
  });
});

/* ================================================================== 6 ================================================================== */

describe("6. the shell wiring (source pins; the behaviour is asserted above)", () => {
  const APP = readShell();

  it("the M&H chip memo reads dockHold.exchangePrivate, not privateTradeHoldReason, and applies pending last", () => {
    const memo = sliceBetween(APP, "const stockRoundPowerOffers = useMemo(", "const pendingDiscard = useMemo(");
    expect(memo).toContain("const hold = dockHold.exchangePrivate;");
    expect(memo).not.toContain("privateTradeHoldReason");
    expect(memo.indexOf("dockHold.exchangePrivate")).toBeLessThan(memo.indexOf("return withPendingMhExchangeChip("));
    /* Declared after `dockHold` and after W2-C's offer authorities -- and not between them. */
    const dock = APP.indexOf("const dockHold = useMemo(");
    const authority = APP.indexOf("const trainOfferRefusalFor = useCallback(");
    const memoAt = APP.indexOf("const stockRoundPowerOffers = useMemo(");
    expect(dock).toBeGreaterThan(-1);
    expect(authority).toBeGreaterThan(dock);
    expect(memoAt).toBeGreaterThan(authority);
    expect(APP.split("dockHoldView({").length - 1).toBe(1);
  });

  it("the bar mount passes offTurnPowerReady without the turn, and sessionReady is unchanged", () => {
    expect(APP).toContain("offTurnPowerReady={controlsEnabled && !actionInFlight && !scrubbing}");
    expect(APP).toContain("sessionReady={controlsEnabled && isMyTurn && !actionInFlight}");
  });

  it("R-JK calls the extracted helpers", () => {
    expect(APP).toContain("jkPowerOfferFor({ state: gameState, actingProtocolId, orSubPhase, armed: jkLayArmed })");
    expect(APP).toContain("const jkArmScopeKey = jkArmScope(gameState, actingProtocolId, orSubPhase);");
    const effect = sliceBetween(APP, "const jkArmScopeKey = jkArmScope(", "const jkPowerOffer = useMemo(");
    expect(effect).toContain("setJkLayArmed(false);");
    expect(effect).toContain("}, [jkArmScopeKey]);");
  });
});
