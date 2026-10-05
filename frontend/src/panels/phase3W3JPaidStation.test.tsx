/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.08): THE PAID STATION CONTROL RESPECTS THE TREASURY WHILE THE D&H KEEPS TOKENS OPEN
// ==================================================================
//
// `stationPlacementBlockReason` returns `null` as soon as the D&H's free station is available (#781: the step stays open
// for it), so the bar's "Place Station Token for $X" stayed live and the board click staged a paid token a poor
// treasury could not pay for -- refused only by the server (`stationPlacementRefusal`'s treasury arm). The paid control
// and the click now ask the paid question (`paidStationRefusal`): the same predicate without the free station.

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "./ContextualActionBar";
import { paidStationRefusal } from "../utils/paidStationView";
import { stationPlacementBlockReason, nextStationTokenCost } from "../gameEngine/stationTokens";
import { stationPlacementRefusal } from "../gameEngine/stationPlacementGate";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { sandboxGameState } from "../gameEngine/sandboxState";
import { STATIC_BOARD_HEXES } from "../components/hexBoardData";
import { boardHomeHexToAxial } from "../gameEngine/homeStationAuthority";
import { DH_PRIVATE_ID } from "../gameEngine/dhPower";
import { RULES_ENGINE_VERSION } from "../gameEngine/rulesVersion";
import type { GameStateResponse } from "../gameEngine/gameState";
import { readShell } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const PRR = 1;
const GRID = sandboxReplayProviders().initialGrid;
const BOARD_HEXES = STATIC_BOARD_HEXES.map((hex) => [hex.q, hex.r] as const);

/** PRR operating at the Place Token step with its home token down and `treasury` in the bank; PRR owns the D&H. */
function board(treasury: string): GameStateResponse {
  const base = sandboxGameState("OperatingRound", 1);
  const prr = base.public_companies.find((company) => company.company_id === PRR)!;
  const home = boardHomeHexToAxial(prr.home_hex_label!)!;
  return {
    ...base,
    rules_engine_version: RULES_ENGINE_VERSION,
    current_round_type: "OperatingRound",
    player_addresses: ["p1", "p2"],
    active_operating_order: [PRR],
    active_corporation_index: 0,
    operating_sub_phase: "Tokens",
    public_companies: base.public_companies.map((company) =>
      company.company_id === PRR
        ? { ...company, is_floated: true, president: "p1", treasury, station_token_hexes: [[home[0], home[1]]], station_tokens: [[home[0], home[1], 0]] }
        : company,
    ),
    private_companies: base.private_companies.map((entry) =>
      entry.private_id === DH_PRIVATE_ID ? { ...entry, owner: null, owner_protocol_id: PRR, closed: false } : entry,
    ),
  } as GameStateResponse;
}
const prrOf = (state: GameStateResponse) => state.public_companies.find((company) => company.company_id === PRR)!;
const input = (state: GameStateResponse) => ({
  mapGrid: GRID,
  company: prrOf(state),
  allCompanies: state.public_companies,
  boardHexes: BOARD_HEXES,
});

describe("W3-J AUD-25.08: the paid question is asked separately from the D&H's free station", () => {
  it("the step stays open for the free station, but the paid station is refused on the treasury", () => {
    const poor = board("10");
    const cost = nextStationTokenCost(prrOf(poor))!;
    expect(cost).toBeGreaterThan(10);
    // #781's step predicate, with the free station: the step has something in it.
    expect(stationPlacementBlockReason({ ...input(poor), extraTokenAvailable: true })).toBeNull();
    // The paid control's question: no.
    expect(paidStationRefusal({ ...input(poor), ticker: "PRR" })).toBe(`PRR's treasury holds $10 and the next station costs $${cost}.`);
  });

  it("its figures are the authority's: the server refuses any paid placement for the same treasury and cost", () => {
    const poor = board("10");
    const cost = nextStationTokenCost(prrOf(poor))!;
    const [q, r] = BOARD_HEXES.find(([hq, hr]) => !(hq === prrOf(poor).station_token_hexes[0][0] && hr === prrOf(poor).station_token_hexes[0][1]))!;
    expect(stationPlacementRefusal(poor, { protocol_id: PRR, q, r, city_index: 0 }, GRID)).toBe(
      `PRR's treasury holds $10 and the next station costs $${cost}.`,
    );
  });

  it("a treasury that can pay is not refused on the treasury", () => {
    expect(paidStationRefusal({ ...input(board("1000")), ticker: "PRR" })).not.toMatch(/treasury/);
  });
});

describe("W3-J AUD-25.08: the bar's paid control greys with that reason", () => {
  type Props = ComponentProps<typeof ContextualActionBar>;
  const noop = () => undefined;
  const props = (over: Partial<Props>): Props =>
    ({
      roundType: "OperatingRound",
      orSubPhase: "Tokens",
      sessionReady: true,
      offTurnPowerReady: true,
      isMyTurn: true,
      onPassTurn: noop,
      passDisabledReason: null,
      turnHoldReason: null,
      onPlaceStationTokenHint: noop,
      stationTokenCost: 40,
      onSkipSubPhase: noop,
      onOpenPrivateTrade: noop,
      ownsAnyTrain: true,
      mustBuyTrain: false,
      privateCompanies: [],
      onRunTrains: noop,
      onPayDividends: noop,
      onWithholdRevenue: noop,
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
      ...over,
    }) as Props;
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
  const station = () =>
    Array.from(host.querySelectorAll("button")).find((button) => (button.textContent ?? "").includes("Place Station Token for")) as HTMLButtonElement;

  it("refused: greyed, and the title is the reason", () => {
    const reason = "PRR's treasury holds $10 and the next station costs $40.";
    act(() => root.render(<ContextualActionBar {...props({ paidStationRefusal: reason })} />));
    expect(station().disabled).toBe(true);
    expect(station().title).toBe(reason);
  });

  it("not refused (or the prop omitted): live, with the price title as before", () => {
    act(() => root.render(<ContextualActionBar {...props({})} />));
    expect(station().disabled).toBe(false);
    expect(station().title).toMatch(/^Costs \$40 from this corporation's treasury/);
  });
});

describe("W3-J AUD-25.08: the shell passes the verdict to the control and asks it at the click", () => {
  const shell = readShell();
  it("the bar is handed the paid verdict", () => {
    expect(shell).toContain("paidStationRefusal={paidStationRefusalNow}");
  });
  it("the token click refuses before staging, ahead of the geometry", () => {
    const click = shell.slice(shell.indexOf("const handleTokenHexClick = useCallback("), shell.indexOf("/** The green check."));
    expect(click.indexOf("if (paidStationRefusalNow !== null)")).toBeGreaterThan(-1);
    expect(click.indexOf("if (paidStationRefusalNow !== null)")).toBeLessThan(click.indexOf("evaluateStationPlacement({"));
    expect(click.indexOf("if (paidStationRefusalNow !== null)")).toBeLessThan(click.indexOf("setPendingToken({"));
  });
});
