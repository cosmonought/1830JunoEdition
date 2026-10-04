/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W2-A (OD-1): THE ACTION BAR UNDER AN AUTHORITATIVE HOLD, RENDERED
// ==================================================================
//
// The bar is rendered for real (no source scan) and its buttons are read off the DOM:
//   1. no hold: ordinary behaviour unchanged -- Skip, End Turn, Pay / Withhold, Run and Pass live with their own titles;
//   2. a hold, the acting seat: every turn move the server would refuse (Skip, End Turn, Pay / Withhold, Run Trains) is
//      greyed with the hold's own sentence; the navigation toggles that open a resolution surface stay live;
//   3. a hold, an unrelated seat: the Stock Round's Pass is greyed with the sentence; in an Operating Round the bar
//      carries no actor controls for a waiting seat, exactly as before (#740), and still none under a hold;
//   4. the legitimate resolver keeps the controls the authority permits: under the v12 funding hold the obligated
//      president keeps the corporate trade and the emergency purchase while the depot's Buy greys; Close Room stays
//      live on a finished game;
//   5. OD-1's exception: during Run Routes and Dividends a non-active seat still sees the route readout and the
//      dividend consequences, hold or no hold.

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "./ContextualActionBar";
import { ProposePrivatePurchase } from "../components/PrivateTradePanel";
import type { PrivateCompanyState } from "../gameEngine/gameState";
import type { TrainRouteDraft } from "../components/RoutePlannerPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ContextualActionBar>;

const HOLD = "PRR's offer of $150 for NYC's 3-train is waiting for the selling president's answer; nothing else can happen until it is answered or withdrawn.";
const noop = () => undefined;

const CORP: NonNullable<Props["activeCorporation"]> = {
  companyId: 1,
  ticker: "PRR",
  fullName: "Pennsylvania Railroad",
  homeHexLabel: "H12",
  privates: [],
  presidentLabel: "Ann",
  presidentAddress: "p1",
  presidentColor: null,
  treasury: 500,
  stationSlots: [],
  trains: ["3"],
  reprievedTrains: [],
  finalRunSchedule: { thisTurn: [], nextTurn: [], doomedThisTurn: false },
  ghostTrains: [],
  carcosanTrains: [],
  isCarcosan: false,
};

const DRAFT: TrainRouteDraft = {
  trainIndex: 0,
  model: "3",
  maxDistance: 3,
  hexLabels: ["H12", "H10"],
  stops: [
    { hex: "H12", value: 30 },
    { hex: "H10", value: 30 },
  ],
  value: 60,
  revenueCentres: 2,
  exceedsMaxDistance: false,
  endsOffTerminus: false,
  tokenBlockReason: null,
};

function baseProps(over: Partial<Props> = {}): Props {
  return {
    roundType: "OperatingRound",
    orSubPhase: "Track",
    sessionReady: true,
    // Phase 3 W2-D: the required off-turn power readiness (no chips are offered by this harness).
    offTurnPowerReady: true,
    isMyTurn: true,
    onPassTurn: noop,
    passDisabledReason: null,
    turnHoldReason: null,
    onPlaceStationTokenHint: noop,
    stationTokenCost: 40,
    activeCorporation: CORP,
    onSkipSubPhase: noop,
    onOpenPrivateTrade: noop,
    ownsAnyTrain: true,
    mustBuyTrain: false,
    activePlayerName: "Ann",
    activePlayerCash: 300,
    activePlayerEscrow: 0,
    privateCompanies: [],
    onRunTrains: noop,
    onPayDividends: noop,
    onWithholdRevenue: noop,
    dividendRevenue: 60,
    dividendRevenueIsThisTurn: true,
    dividendPerShare: 6,
    dividendPayouts: [],
    rustOutlookForBar: null,
    dividendPrice: null,
    payProjection: null,
    withholdProjection: null,
    selectedHardwareModel: "3",
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
    maxRouteRevenue: 60,
    ...over,
  } as Props;
}

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

function render(props: Props) {
  act(() => root.render(<ContextualActionBar {...props} />));
}

/** Every button whose visible text starts with `label`. */
const buttons = (label: string | RegExp) =>
  Array.from(host.querySelectorAll("button")).filter((button) => {
    const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
    return typeof label === "string" ? text.startsWith(label) : label.test(text);
  });
const one = (label: string | RegExp) => {
  const found = buttons(label);
  expect(found.length).toBeGreaterThan(0);
  return found[0];
};
const live = (button: HTMLButtonElement) => !button.disabled;

/* ================================================================================================== */
describe("1. no hold: ordinary behaviour unchanged", () => {
  it("Track: Skip is live with its own tooltip", () => {
    render(baseProps({ orSubPhase: "Track" }));
    const skip = one("Skip");
    expect(live(skip)).toBe(true);
    expect(skip.title).toMatch(/^Move past .* without acting\. The turn goes on to its next step\.$/);
    expect(live(one("Lay 1 Track"))).toBe(true);
  });

  it("Dividends: Pay and Withhold are live with their own tooltips", () => {
    render(baseProps({ orSubPhase: "Dividends" }));
    expect(live(one("Pay Dividends $60"))).toBe(true);
    expect(one("Pay Dividends $60").title).toMatch(/^Splits \$60/);
    expect(live(one("Withhold $60 to Treasury"))).toBe(true);
  });

  it("Buy Trains: End Turn is live (a train is owned)", () => {
    render(baseProps({ orSubPhase: "Hardware" }));
    const end = one("End Turn");
    expect(live(end)).toBe(true);
    expect(end.title).toBe("Finish this corporation's turn and pass to the next in the queue.");
  });

  it("Run Routes: Run Trains is live once a route is drafted", () => {
    render(baseProps({ orSubPhase: "Routes", trainDrafts: [DRAFT] }));
    const run = one("Run Trains for Projected Revenue");
    expect(live(run)).toBe(true);
  });

  it("Stock Round: Pass is live with its own tooltip", () => {
    render(baseProps({ roundType: "StockRound", activeCorporation: null }));
    const pass = host.querySelector<HTMLButtonElement>('[data-testid="pass-turn-button"]')!;
    expect(live(pass)).toBe(true);
    expect(pass.title).not.toBe(HOLD);
  });
});

/* ================================================================================================== */
describe("2. a hold, the acting seat: every refused turn move is greyed with the hold's sentence", () => {
  it("Track: Skip greys with the sentence; Lay 1 Track (a tab switch, no dispatch) stays a navigation control", () => {
    render(baseProps({ orSubPhase: "Track", turnHoldReason: HOLD }));
    const skip = one("Skip");
    expect(live(skip)).toBe(false);
    expect(skip.title).toBe(HOLD);
    expect(live(one("Lay 1 Track"))).toBe(true);
  });

  it("Tokens: Skip greys with the sentence", () => {
    render(baseProps({ orSubPhase: "Tokens", turnHoldReason: HOLD }));
    expect(live(one("Skip"))).toBe(false);
    expect(one("Skip").title).toBe(HOLD);
  });

  it("Dividends: Pay and Withhold grey with the sentence", () => {
    render(baseProps({ orSubPhase: "Dividends", turnHoldReason: HOLD }));
    for (const label of ["Pay Dividends $60", "Withhold $60 to Treasury"]) {
      expect([label, live(one(label)), one(label).title]).toEqual([label, false, HOLD]);
    }
  });

  it("Dividends at $0: the forced withhold greys with the sentence too", () => {
    render(baseProps({ orSubPhase: "Dividends", dividendRevenue: 0, dividendPerShare: 0, turnHoldReason: HOLD }));
    expect([live(one("Withhold $0")), one("Withhold $0").title]).toEqual([false, HOLD]);
  });

  it("Buy Trains: End Turn greys with the sentence, which outranks the train obligation's", () => {
    render(baseProps({ orSubPhase: "Hardware", turnHoldReason: HOLD }));
    expect([live(one("End Turn")), one("End Turn").title]).toEqual([false, HOLD]);
    render(baseProps({ orSubPhase: "Hardware", turnHoldReason: HOLD, mustBuyTrain: true }));
    expect([live(one("End Turn")), one("End Turn").title]).toEqual([false, HOLD]);
  });

  it("Run Routes: Run Trains greys with the sentence", () => {
    render(baseProps({ orSubPhase: "Routes", trainDrafts: [DRAFT], turnHoldReason: HOLD }));
    const run = one("Run Trains for Projected Revenue");
    expect([live(run), run.title]).toEqual([false, HOLD]);
  });

  it("Stock Round: Pass greys with the sentence (the shell hands it in as `passDisabledReason`)", () => {
    render(baseProps({ roundType: "StockRound", activeCorporation: null, passDisabledReason: HOLD, turnHoldReason: HOLD }));
    const pass = host.querySelector<HTMLButtonElement>('[data-testid="pass-turn-button"]')!;
    expect([live(pass), pass.title]).toEqual([false, HOLD]);
  });
});

/* ================================================================================================== */
describe("3. a hold, an unrelated seat", () => {
  it("Stock Round: the waiting seat's Pass is greyed with the hold's sentence", () => {
    render(
      baseProps({ roundType: "StockRound", activeCorporation: null, isMyTurn: false, sessionReady: false, passDisabledReason: HOLD, turnHoldReason: HOLD }),
    );
    const pass = host.querySelector<HTMLButtonElement>('[data-testid="pass-turn-button"]')!;
    expect([live(pass), pass.title]).toEqual([false, HOLD]);
  });

  it.each(["Track", "Tokens", "Dividends", "Hardware", "Routes"] as const)(
    "Operating Round %s: no actor control is offered to a waiting seat, hold or not (#740 unchanged)",
    (step) => {
      for (const turnHoldReason of [null, HOLD]) {
        render(baseProps({ orSubPhase: step, isMyTurn: false, sessionReady: false, trainDrafts: [DRAFT], turnHoldReason }));
        for (const label of ["Skip", "End Turn", "Pay Dividends", "Withhold", "Run Trains", "Lay 1 Track", "Place Station Token"]) {
          expect([step, turnHoldReason, label, buttons(label).length]).toEqual([step, turnHoldReason, label, 0]);
        }
      }
    },
  );
});

/* ================================================================================================== */
describe("4. the legitimate resolver keeps the controls the authority permits", () => {
  const FUNDING = "C&O must buy a 3-train ($180) and cannot pay for it; its president must fund the purchase before anything else happens.";
  const depot = [
    { tier: "3", cost: 180, remaining: 5, rustsOn: null, available: true, soldOut: false, rusted: false },
  ] as unknown as NonNullable<Props["trainPurchase"]>["depot"];
  const trainPurchase = (over: Partial<NonNullable<Props["trainPurchase"]>> = {}): NonNullable<Props["trainPurchase"]> => ({
    depot,
    buyer: { company_id: 5, ticker: "C&O", treasury: "30", owned_trains: [], president: "p1" } as never,
    companies: [
      { company_id: 5, ticker: "C&O", treasury: "30", owned_trains: [], president: "p1" },
      { company_id: 1, ticker: "PRR", treasury: "500", owned_trains: ["3", "3"], president: "p3" },
    ] as never,
    canAct: true,
    blockedReason: null,
    bankBlockedReason: FUNDING,
    onBuyFromBank: noop,
    endsTurnAtLimit: false,
    onEmergencyPurchase: noop,
    emergencyAvailable: true,
    onProposeTrade: noop,
    labelForAddress: (address: string) => address,
    ...over,
  });

  /* The corporate trade's liveness under this hold is the pure matrix's (`dockHold.proposeTrainPurchase` is null under the
     v12 funding hold, so the panel's `blockedReason` is null); its controls sit behind the roster disclosure. */
  it("the forced purchase (v12): the depot's Buy greys with the sentence; the emergency purchase stays; End Turn greys", () => {
    render(
      baseProps({
        orSubPhase: "Hardware",
        activeCorporation: { ...CORP, companyId: 5, ticker: "C&O", trains: [], treasury: 30 },
        ownsAnyTrain: false,
        mustBuyTrain: true,
        turnHoldReason: FUNDING,
        trainPurchase: trainPurchase(),
      }),
    );
    // The panel opens itself on a forced step (#792); its toggle is navigation and stays live.
    expect(live(one(/^(Hide|Buy) Trains$/))).toBe(true);
    expect([live(one("End Turn")), one("End Turn").title]).toEqual([false, FUNDING]);
    const pay = buttons(/^\$180/)[0] ?? buttons(/Pay \$180/)[0];
    expect(pay).toBeDefined();
    expect([live(pay), pay.title]).toEqual([false, FUNDING]);
    const emergency = buttons(/emergency/i);
    expect(emergency.length).toBeGreaterThan(0);
    expect(live(emergency[0])).toBe(true);
  });

  it("the depot Buy is live again once no hold stands (ordinary purchase)", () => {
    render(
      baseProps({
        orSubPhase: "Hardware",
        activeCorporation: { ...CORP, companyId: 5, ticker: "C&O", trains: [], treasury: 500 },
        mustBuyTrain: true,
        trainPurchase: trainPurchase({
          bankBlockedReason: null,
          emergencyAvailable: false,
          buyer: { company_id: 5, ticker: "C&O", treasury: "500", owned_trains: [], president: "p1" } as never,
        }),
      }),
    );
    const pay = buttons(/Pay \$180/)[0];
    expect(pay).toBeDefined();
    expect(live(pay)).toBe(true);
  });

  it("a finished game: Close Room stays live for every seat while Pass greys with the game-end sentence", () => {
    const ENDED = "The game has ended. Nothing further can be played.";
    render(
      baseProps({ roundType: "GameEnd", activeCorporation: null, isMyTurn: false, sessionReady: true, onCloseRoom: noop, passDisabledReason: ENDED, turnHoldReason: ENDED }),
    );
    expect(live(one("Close Room"))).toBe(true);
    const pass = host.querySelector<HTMLButtonElement>('[data-testid="pass-turn-button"]')!;
    expect([live(pass), pass.title]).toEqual([false, ENDED]);
  });
});

/* ================================================================================================== */
describe("5. OD-1's exception: Run Routes and Dividends stay informational for non-active seats", () => {
  it.each([null, HOLD])("Run Routes: the drafted-route readout is shown to a waiting seat (hold: %s)", (turnHoldReason) => {
    render(baseProps({ orSubPhase: "Routes", isMyTurn: false, sessionReady: false, trainDrafts: [DRAFT], turnHoldReason }));
    const row = host.querySelector('[aria-label="Drafted routes"]');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll("button").length).toBe(1);
    // The readout chip opens for a watcher -- it dispatches nothing and is never greyed.
    expect((row!.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([null, HOLD])("Dividends: the consequences are shown to a waiting seat (hold: %s)", (turnHoldReason) => {
    render(baseProps({ orSubPhase: "Dividends", isMyTurn: false, sessionReady: false, turnHoldReason }));
    expect(host.textContent).toContain("No shareholders on record");
    expect(buttons("Pay Dividends").length).toBe(0);
  });
});

/* ================================================================================================== */
describe("the embedded Buy Private Company panel greys its submit with the hold's sentence", () => {
  const PRIVATE = {
    private_id: 3,
    name: "Delaware & Hudson",
    cost: "70",
    revenue_per_or: "15",
    owner: "p2",
    owner_protocol_id: null,
    closed: false,
  } as unknown as PrivateCompanyState;
  const panel = (blockedReason: string | null) => (
    <ProposePrivatePurchase
      embedded
      open
      buyerTicker="PRR"
      privates={[PRIVATE]}
      treasury={500}
      labelForAddress={(address) => (address === "p2" ? "Ben" : address)}
      onPropose={noop}
      onClose={noop}
      blockedReason={blockedReason}
    />
  );
  const openCardAndFindSubmit = () => {
    act(() => one(/Delaware & Hudson/).click());
    return one("Propose Purchase to Ben");
  };

  it("no hold: the submit is live", () => {
    act(() => root.render(panel(null)));
    expect(live(openCardAndFindSubmit())).toBe(true);
  });

  it("a hold: the submit greys, with the sentence as its title and on the card's problem line", () => {
    act(() => root.render(panel(HOLD)));
    const submit = openCardAndFindSubmit();
    expect([live(submit), submit.title]).toEqual([false, HOLD]);
    expect(host.textContent).toContain(HOLD);
  });
});
