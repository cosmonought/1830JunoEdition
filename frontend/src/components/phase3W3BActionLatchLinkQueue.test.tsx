/** @jest-environment jsdom */
/**
 * Phase 3 W3-B — AUD-25.01 / U-46 (MEDIUM): the action latch is bounded by the room link, not by the clock.
 *
 * W3-G found the shell's six-second latch backstop (#1173) re-arming the OR bar, the Stock Round's Buy / Sell / Pass,
 * the consent prompts and the W2-G emergency modal while the room link still held the first submission (queued for a
 * socket, or sent and unanswered) -- so a second press became a second message, and a second sale could legally land.
 *
 * Everything here runs against the REAL link (`connectServerLink`) over a hand-driven socket, read through the REAL
 * hooks (`useLinkQueue`, `useActionLatch`) and rendered through the REAL controls. The one stand-in is the shell's
 * dispatch, reduced to the three latch lines `runGameplayAction` runs (RED R1: set before the await -- for every press
 * but a `derived` one since W3-B's P3-N021 commit -- released on a `null`) and the drain's index release (RED R5,
 * unchanged) -- pinned against App.tsx at the bottom. The residue's own suite is `phase3W3BLatchResidue.test.tsx`.
 * A landed entry is applied through the real reducer, so "re-arms" is the authority's next answer, never the test's.
 */
import React, { act, useCallback, useRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "../panels/ContextualActionBar";
import StockRoundPanel from "./StockRoundPanel";
import { TrainTradePrompt } from "./TrainPurchasePanel";
import { PrivateCompaniesSection } from "./PrivateCompaniesSection";
import { ModalLayerHost } from "./ModalPortal";
import {
  EmergencyTrainPurchaseModal,
  buildEmergencyPurchasePlan,
  type EmergencyTrainPurchaseModalProps,
} from "./EmergencyTrainPurchaseModal";
import { STATIC_BOARD_HEXES } from "./hexBoardData";
import type { MapGridResponse } from "./hexContractTypes";
import { applySandboxAction } from "../gameEngine/sandboxSession";
import { sandboxReplayProviders } from "../gameEngine/replayProviders";
import { STANDARD_VARIANTS, CURRENT_RULES_REVISION, resolveVariants } from "../gameEngine/gameVariants";
import { chartContextFromState, stockPurchaseRefusal, stockSaleRefusal } from "../gameEngine/stockTransactionAuthority";
import { routeRulesRevisionOf, withRules } from "../gameEngine/boardSelection";
import { marketCellForPrice } from "../gameEngine/marketGeometry";
import {
  emergencyFundingFor,
  forgoPrivateFundingRefusal,
  forgoTrainTradeRefusal,
} from "../gameEngine/emergencyFunding";
import type { GameStateResponse, RoundType } from "../gameEngine/gameState";
import type { ReplayEntry } from "../gameEngine/replayLog";
import {
  decisionConsequenceFor,
  emergencyStageFor,
  fundingOfferDraftRefusal,
  intercorporateOfferRefusal,
  intercorporateStepFor,
  portfolioVerdictFor,
} from "../utils/emergencyPurchaseView";
import { connectServerLink, getActiveLinkQueue, IDLE_LINK_QUEUE, type ServerLink, type SocketLike } from "../utils/serverLink";
import { LINK_QUEUED_NOTE, linkQueueView, useLinkQueue, type LinkQueueView } from "../utils/useLinkQueue";
import { actionLatchBusy, useActionLatch } from "../utils/actionLatch";
import { P1 as OP1, P2 as OP2, P3 as OP3, CA, DH, MH, PRR as OPRR, stockRoundBoard } from "../utils/offerFixtures74";
import { privateTradeProposalRefusal, privateTradeSectionModel } from "../utils/stockRoundPrivateTrade";
import { expectOrder, readShell, readStripped, sliceBetween } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/** App.tsx's `ACTION_LATCH_BACKSTOP_MS` (pinned at the bottom). */
const BACKSTOP_MS = 6000;
/** Well past both the shell's backstop and the emergency modal's own 4 s press latch. */
const LONG_PAST = BACKSTOP_MS * 3;
const SENDING = "Sending your last action — one moment.";
const noop = () => undefined;
type Msg = Record<string, unknown>;

/* ---- a real link over hand-driven sockets (the W3-I harness), whose entries wait for the drain ------------------- */

function fakeSocket() {
  const sent: string[] = [];
  const socket: SocketLike = {
    send: (data) => sent.push(data),
    close: () => socket.onclose?.({}),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return {
    socket,
    frames: () => sent.map((text) => JSON.parse(text) as Record<string, unknown>),
    open: () => socket.onopen?.({}),
    deliver: (frame: unknown) => socket.onmessage?.({ data: JSON.stringify(frame) }),
    drop: () => socket.onclose?.({}),
  };
}
type Wire = ReturnType<typeof fakeSocket>;
const submits = (wire: Wire) => wire.frames().filter((frame) => frame.kind === "submit");

interface Room {
  client: ServerLink;
  wire: () => Wire;
  wires: Wire[];
  /** Entries the link has handed to the shell and the shell's drain has not applied yet. */
  inbox: ReplayEntry[];
  reconnect: () => void;
  /** Every submit frame this link has put on any socket. */
  allSubmits: () => Array<Record<string, unknown>>;
  /** The message a submission carried, by its id (read off the wire). */
  msgOf: (submissionId: string) => Msg;
  /** The server lands a submission: one entry at `index`, answered to its submitter. */
  land: (submissionId: string, index: number) => void;
  refuse: (submissionId: string, reason?: string) => void;
  /** Set by the mounted shell: apply what the inbox holds. */
  drain: () => void;
}

const links: ServerLink[] = [];
function room(): Room {
  const wires: Wire[] = [];
  const timers: Array<() => void> = [];
  const inbox: ReplayEntry[] = [];
  let ids = 0;
  const client = connectServerLink({
    url: "ws://test",
    gameId: "g_0123456789abcdefghjkmnpqr0",
    build: "build-1",
    onEntries: (entries) => {
      inbox.push(...entries);
    },
    socketFactory: () => {
      const wire = fakeSocket();
      wires.push(wire);
      return wire.socket;
    },
    mintSubmissionId: () => `n${(ids += 1)}`,
    schedule: (callback) => {
      timers.push(callback);
    },
  });
  links.push(client);
  const wire = () => wires[wires.length - 1];
  const allSubmits = () => wires.flatMap(submits);
  const made: Room = {
    client,
    wire,
    wires,
    inbox,
    reconnect: () => {
      const due = timers.splice(0);
      for (const callback of due) callback();
      act(() => wire().open());
    },
    allSubmits,
    msgOf: (submissionId) => {
      const frame = allSubmits().find((candidate) => candidate.submissionId === submissionId);
      if (!frame) throw new Error(`no submission ${submissionId} on the wire`);
      return frame.msg as Msg;
    },
    land: (submissionId, index) =>
      act(() =>
        wire().deliver({
          kind: "applied",
          build: "build-1",
          digest: "0".repeat(16),
          entries: [{ index, id: `e${index}`, actor: "p-ann", payload: "{}", submission_id: submissionId }],
          inReplyTo: submissionId,
        }),
      ),
    refuse: (submissionId, reason = "Not now.") =>
      act(() => wire().deliver({ kind: "refused", build: "build-1", reason, inReplyTo: submissionId })),
    drain: noop,
  };
  return made;
}

/* ---- the shell, reduced to the latch -------------------------------------------------------------------------------- */

interface ShellApi {
  board: GameStateResponse;
  actionInFlight: boolean;
  view: LinkQueueView;
  /** A press, dispatched as `runGameplayAction` does (every press but a `derived` one takes the latch -- P3-N021). */
  press: (msg: Msg, options?: { automatic?: boolean; derived?: boolean }) => void;
}

/** The shell's composition: W3-I's one hook and view, W3-B's latch, the submit half's three latch lines and the
 *  drain's index release. `apply` is the reducer for whatever the drain hands over. */
function Shell({
  link,
  initial,
  apply,
  children,
}: {
  link: Room;
  initial: GameStateResponse;
  apply: (board: GameStateResponse, msg: Msg) => GameStateResponse;
  children: (api: ShellApi) => React.ReactNode;
}) {
  const [pendingAppendIndex, setPendingAppendIndex] = useState<number | null>(null);
  const view = linkQueueView(useLinkQueue());
  const actionInFlight = useActionLatch(pendingAppendIndex, setPendingAppendIndex, view.blocked, BACKSTOP_MS);
  const [board, setBoard] = useState(initial);
  const appliedIndexRef = useRef(0);
  const press = useCallback(
    (msg: Msg, options?: { automatic?: boolean; derived?: boolean }) => {
      const appendAt = appliedIndexRef.current;
      // RED R1 (W3-B P3-N021): "Design note #1173a, whose reasoning is on `pendingAppendIndex`."
      if (options?.derived !== true) setPendingAppendIndex(appendAt);
      void link.client.submit(msg as never).then((allocated) => {
        // RED R1, as is: "released -- nothing will advance the cursor past an action that never landed."
        if (allocated === null) setPendingAppendIndex((current) => (current === appendAt ? null : current));
      });
    },
    [link, setPendingAppendIndex],
  );
  link.drain = () => {
    const entries = link.inbox.splice(0);
    // This tab's entries carry their message on the wire; another seat's entry only advances the index here.
    const ours = entries.map((entry) => (entry as { submission_id?: string }).submission_id).filter((id): id is string => id !== undefined);
    setBoard((current) => ours.reduce((next, id) => apply(next, link.msgOf(id)), current));
    appliedIndexRef.current += entries.length;
    // RED R5, as is: the drain releases the latch against the index it was taken at.
    setPendingAppendIndex((current) => (current !== null && appliedIndexRef.current > current ? null : current));
  };
  return <>{children({ board, actionInFlight, view, press })}</>;
}

/* ---- rendering ------------------------------------------------------------------------------------------------------ */

let host: HTMLDivElement;
let root: Root;
let layerHost: HTMLDivElement;
let layerRoot: Root;
beforeEach(() => {
  jest.useFakeTimers();
  layerHost = document.createElement("div");
  document.body.appendChild(layerHost);
  layerRoot = createRoot(layerHost);
  act(() => layerRoot.render(<ModalLayerHost />));
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => layerRoot.unmount());
  layerHost.remove();
  for (const link of links.splice(0)) act(() => link.close());
  jest.useRealTimers();
});

const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const click = (node: Element | null | undefined) => {
  if (!node) throw new Error("nothing to click");
  act(() => void node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
};
const text = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
const allButtons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"));
const buttonNamed = (match: RegExp) => {
  const found = allButtons().find((node) => match.test(text(node)));
  if (!found) throw new Error(`no button ${String(match)} in: ${allButtons().map(text).join(" | ")}`);
  return found;
};

/* ================================================================================================================ */
/*  A v13 Stock Round (the W2-B shape): p0 holds PRR 20% -- so a sale leaves a second sale legal (W3-G's example)      */
/* ================================================================================================================ */

const SEATS = ["p0", "p1", "p2", "p3"];
const PRR = 1;
const NYC = 3;
function mark(company_id: number, price: number, enteredAt: number) {
  const cell = marketCellForPrice(price);
  if (!cell) throw new Error(`no cell for ${price}`);
  return { x: cell.x, y: cell.y, price, enteredAt, company_id };
}
function srBoard(): GameStateResponse {
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
    rules_engine_version: 13,
    variants: { ...STANDARD_VARIANTS, rules: CURRENT_RULES_REVISION },
    public_companies: [
      {
        company_id: PRR, ticker: "PRR", president: "p1", par_value: "100", is_floated: true,
        ipo_pool_percentage: 30, bank_pool_percentage: 10,
        player_holdings: [ { player: "p0", percentage: 20 }, { player: "p1", percentage: 40 } ],
        station_token_hexes: [],
      },
      {
        company_id: NYC, ticker: "NYC", president: "p3", par_value: "90", is_floated: true,
        ipo_pool_percentage: 40, bank_pool_percentage: 0,
        player_holdings: [ { player: "p0", percentage: 10 }, { player: "p3", percentage: 50 } ],
        station_token_hexes: [],
      },
    ],
    market_positions: { [PRR]: mark(PRR, 100, 1), [NYC]: mark(NYC, 90, 2) },
  } as unknown as GameStateResponse;
}
const seatOf = (s: GameStateResponse) => s.player_addresses[s.active_player_index];
const srApply = (s: GameStateResponse, msg: Msg) => {
  const chart = chartContextFromState(s);
  return applySandboxAction(s, msg as never, {
    actor: seatOf(s), marketZoneFor: chart.marketZoneFor, marketPricesByCompany: chart.marketPricesByCompany, zoneForPrice: chart.zoneForPrice,
  } as never);
};
const SELL = (id: number, percentage = 10): Msg => ({ SellStock: { game_id: 1, protocol_id: id, percentage } });
const PASS: Msg = { PassTurn: { game_id: 1 } };
const holding = (s: GameStateResponse, id: number, who = "p0") =>
  s.public_companies.find((c) => c.company_id === id)!.player_holdings.find((h) => h.player === who)?.percentage ?? 0;
function srGates(state: GameStateResponse, viewer: string) {
  const scoped = (ask: () => string | null) => withRules(resolveVariants(state.variants), ask, routeRulesRevisionOf(state));
  return {
    purchaseBlockFor: (companyId: number, source: "Ipo" | "Bank", quantity: number) =>
      scoped(() =>
        stockPurchaseRefusal({ state, buy: { companyId, source, parValue: null, quantity, certificate: null }, actor: viewer, ctx: chartContextFromState(state) }),
      ),
    saleBlockFor: (companyId: number, percentage: number) =>
      scoped(() => stockSaleRefusal({ state, sell: { companyId, percentage }, actor: viewer, ctx: chartContextFromState(state) })),
  };
}

type BarProps = ComponentProps<typeof ContextualActionBar>;
/** The bar as the shell mounts it: `sessionReady={controlsEnabled && isMyTurn && !actionInFlight}` (pinned below). */
function srBarProps(state: GameStateResponse, actionInFlight: boolean, onPassTurn: () => void): BarProps {
  return {
    roundType: state.current_round_type as RoundType,
    orSubPhase: "Track",
    sessionReady: true && seatOf(state) === "p0" && !actionInFlight,
    offTurnPowerReady: !actionInFlight,
    isMyTurn: seatOf(state) === "p0",
    onPassTurn,
    passDisabledReason: null,
    turnHoldReason: null,
    turnActionTaken: state.turn_action_taken === true,
    onPlaceStationTokenHint: noop, stationTokenCost: 40, activeCorporation: null, onSkipSubPhase: noop, onOpenPrivateTrade: noop,
    ownsAnyTrain: false, mustBuyTrain: false, activePlayerName: "p0", activePlayerCash: 2000, activePlayerEscrow: 0,
    privateCompanies: [], onRunTrains: noop, onPayDividends: noop, onWithholdRevenue: noop, dividendRevenue: 0,
    dividendRevenueIsThisTurn: false, dividendPerShare: 0, dividendPayouts: [], rustOutlookForBar: null, dividendPrice: null,
    payProjection: null, withholdProjection: null, selectedHardwareModel: "2", onEndOperatingTurn: noop, onUndoLastAction: noop,
    onAutoRoute: noop, onSelectRouteTrain: noop, highlightedRouteIndex: null, onHighlightRoute: noop, trainDrafts: [],
    activeTrainIndex: 0, routeFeedback: null, onClearRoute: noop, currentGlobalEra: null, maxRouteRevenue: 0,
  } as BarProps;
}

/** The Stocks tab and the bar, mounted on the shell exactly as App.tsx wires them (`actionInFlight` to both). */
function mountStockRound(link: Room, initial = srBoard()) {
  act(() =>
    root.render(
      <Shell link={link} initial={initial} apply={srApply}>
        {({ board, actionInFlight, press }) => {
          const gates = srGates(board, "p0");
          return (
            <>
              <ContextualActionBar {...srBarProps(board, actionInFlight, () => press(PASS))} />
              <StockRoundPanel
                publicCompanies={board.public_companies}
                privateCompanies={board.private_companies}
                parValueFor={() => "100"}
                onSelectParValue={noop}
                onBuyShare={(protocolId, source) => press({ BuyStock: { game_id: 1, protocol_id: protocolId, source } })}
                onSellShares={(protocolId, percentage) => press(SELL(protocolId, percentage))}
                sessionReady
                isMyTurn={seatOf(board) === "p0"}
                actionInFlight={actionInFlight}
                connectedAddress="p0"
                macroRoundNumber={board.macro_round_number}
                playerCash={2000}
                marketPrices={{ [PRR]: 100, [NYC]: 90 }}
                roundType={board.current_round_type as RoundType}
                purchaseBlockFor={gates.purchaseBlockFor}
                saleBlockFor={gates.saleBlockFor}
              />
              <span data-testid="prr-held">{holding(board, PRR)}</span>
            </>
          );
        }}
      </Shell>,
    ),
  );
}
const openCard = (ticker: string) => click(host.querySelector(`button[aria-label="${ticker} — show share actions"]`));
const sellButton = () => allButtons().find((node) => /^Sell \d+% Bundle$/.test(text(node)));
const passButton = () => allButtons().find((node) => node.getAttribute("data-testid") === "pass-turn-button")!;
const prrHeld = () => Number(host.querySelector('[data-testid="prr-held"]')?.textContent);

/* ================================================================================================================ */
describe("AUD-25.01 (1)-(6): the latch is bounded by the link's queue, released by ordinary authority", () => {
  it("1. a normal submission: latched from the press, held through the link's answer, released by the drain", () => {
    const link = room();
    act(() => link.wire().open());
    mountStockRound(link);
    openCard("PRR");
    expect(sellButton()!.disabled).toBe(false);
    click(sellButton());
    expect(sellButton()!.disabled).toBe(true);
    expect(sellButton()!.title).toBe(SENDING);
    expect(link.allSubmits()).toHaveLength(1);
    // The server lands it. The link has let go -- but the drain has not applied the entry yet: still latched
    // (re-arming here would judge a board one round trip old, #1173's own window).
    link.land("n1", 0);
    expect(link.client.queue.unsettled).toBe(0);
    expect(sellButton()!.disabled).toBe(true);
    act(() => link.drain());
    expect(prrHeld()).toBe(10);
    expect(sellButton()!.disabled).toBe(false);
  });

  it("2. the 6 s latch expires while the queue still holds the move: every control stays unavailable", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop()); // the link is reconnecting
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    expect(getActiveLinkQueue()).toMatchObject({ unsent: 1, unsettled: 1 });
    advance(LONG_PAST);
    expect(getActiveLinkQueue()).toMatchObject({ unsent: 1, unsettled: 1 }); // still the link's
    expect(sellButton()!.disabled).toBe(true);
    expect(sellButton()!.title).toBe(SENDING);
    expect(passButton().disabled).toBe(true);
    openCard("NYC");
    expect(sellButton()!.disabled).toBe(true);
  });

  it("3. a second click after the latch would have expired queues nothing", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST);
    click(sellButton());
    click(passButton());
    expect(link.client.queue.unsettled).toBe(1);
    link.reconnect();
    expect(link.allSubmits()).toHaveLength(1); // exactly the first press, after the hello
  });

  it("4. the queue clears after an ACCEPTED move -> the drain re-arms the control (no stale lock, no wait on the clock)", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST);
    link.reconnect();
    expect(sellButton()!.disabled).toBe(true); // sent, not answered
    link.land("n1", 0);
    // The link holds nothing now, but the landed entry is not on the board yet -- still latched.
    expect(sellButton()!.disabled).toBe(true);
    act(() => link.drain());
    expect(prrHeld()).toBe(10);
    expect(sellButton()!.disabled).toBe(false); // no timer advanced: the drain released it
  });

  it("5. the queue clears after a REFUSAL -> the control re-arms at once, by the board's authority", async () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST);
    link.reconnect();
    link.refuse("n1", "Not now.");
    await flush();
    expect(link.client.queue).toMatchObject({ unsettled: 0, lastOutcome: "not-applied" });
    expect(prrHeld()).toBe(20); // nothing landed
    expect(sellButton()!.disabled).toBe(false);
    expect(sellButton()!.title).not.toBe(SENDING);
  });

  it("6. a DROPPED submission (the link closed with it) -> the controls are usable again, nothing stale", async () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST);
    expect(sellButton()!.disabled).toBe(true);
    act(() => link.client.close()); // the room was left: settled `null`, the store back to idle
    await flush();
    expect(getActiveLinkQueue()).toBe(IDLE_LINK_QUEUE);
    expect(sellButton()!.disabled).toBe(false);
    expect(passButton().disabled).toBe(false);
  });

  it("6b. a dropped submission the server abandons (LIVE-3A) releases the same way", async () => {
    const link = room();
    act(() => link.wire().open());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    act(() => link.wire().deliver({ kind: "refused", build: "build-1", code: "unavailable", reason: "Could not confirm.", inReplyTo: "n1" }));
    advance(LONG_PAST);
    expect(link.client.queue.unsettled).toBe(1); // the server is still committing it
    expect(sellButton()!.disabled).toBe(true);
    act(() => link.wire().deliver({ kind: "abandoned", build: "build-1", inReplyTo: "n1" }));
    await flush();
    expect(sellButton()!.disabled).toBe(false);
  });
});

/* ================================================================================================================ */
describe("AUD-25.01 (7): W3-G's example -- a second Stock Round sale cannot sneak through", () => {
  it("the second sale IS legal after the first (the authority is unchanged), and still only one is sent", () => {
    // The authority: a sale leaves a second sale of the same holding legal -- this is what could have landed.
    const once = srApply(srBoard(), SELL(PRR));
    expect(srGates(once, "p0").saleBlockFor(PRR, 10)).toBeNull();
    expect(holding(srApply(once, SELL(PRR)), PRR)).toBe(0);

    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST); // the old 6 s release
    click(sellButton()); // the press that used to queue a second SellStock
    advance(LONG_PAST);
    click(sellButton());
    link.reconnect();
    expect(link.allSubmits().map((frame) => Object.keys(frame.msg as Msg)[0])).toEqual(["SellStock"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(prrHeld()).toBe(10); // ONE sale landed, not two
    // Ordinary game authority now: the second sale is the player's to make, deliberately.
    expect(sellButton()!.disabled).toBe(false);
    click(sellButton());
    expect(link.allSubmits()).toHaveLength(2);
  });
});

/* ================================================================================================================ */
describe("AUD-25.01 (8): the Operating Round action bar cannot duplicate", () => {
  const CORP: NonNullable<BarProps["activeCorporation"]> = {
    companyId: 1, ticker: "PRR", fullName: "Pennsylvania Railroad", homeHexLabel: "H12", privates: [], presidentLabel: "Ann",
    presidentAddress: "p1", presidentColor: null, treasury: 500, stationSlots: [], trains: ["3"], reprievedTrains: [],
    finalRunSchedule: { thisTurn: [], nextTurn: [], doomedThisTurn: false }, ghostTrains: [], carcosanTrains: [], isCarcosan: false,
  };
  function mountOr(link: Room) {
    act(() =>
      root.render(
        <Shell link={link} initial={srBoard()} apply={(board) => board}>
          {({ actionInFlight, press }) => (
            <ContextualActionBar
              {...srBarProps(srBoard(), actionInFlight, noop)}
              roundType="OperatingRound"
              orSubPhase="Track"
              activeCorporation={CORP}
              ownsAnyTrain
              onSkipSubPhase={() => press({ AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 1 } })}
            />
          )}
        </Shell>,
      ),
    );
  }
  const skip = () => buttonNamed(/^Skip/);

  it("Skip: held past the backstop while queued, one message, re-armed when the move lands", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountOr(link);
    expect(skip().disabled).toBe(false);
    click(skip());
    advance(LONG_PAST);
    expect(skip().disabled).toBe(true);
    click(skip());
    link.reconnect();
    expect(link.allSubmits()).toHaveLength(1);
    link.land("n1", 0);
    act(() => link.drain());
    expect(skip().disabled).toBe(false);
  });
});

/* ================================================================================================================ */
describe("AUD-25.01 (9): a consent answer cannot duplicate", () => {
  const proposal = {
    sellerProtocolId: 2, sellerTicker: "NYC", sellerPresident: "p0", sellerPresidentLabel: "Ann",
    buyerProtocolId: 1, buyerTicker: "PRR", modelType: "3", price: "150",
  };
  function mountConsent(link: Room) {
    act(() =>
      root.render(
        <Shell link={link} initial={srBoard()} apply={(board) => board}>
          {({ actionInFlight, press }) => (
            <TrainTradePrompt
              proposal={proposal as never}
              viewerIsSeller
              onAccept={() => press({ AnswerTrainPurchase: { accept: true } })}
              onReject={() => press({ AnswerTrainPurchase: { accept: false } })}
              actionInFlight={actionInFlight}
            />
          )}
        </Shell>,
      ),
    );
  }

  it("Accept, then Accept / Reject again past the backstop: one answer on the wire; a refusal re-arms both", async () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountConsent(link);
    click(buttonNamed(/^Accept/));
    advance(LONG_PAST);
    expect(buttonNamed(/^Accept/).disabled).toBe(true);
    expect(buttonNamed(/^Reject/).disabled).toBe(true);
    click(buttonNamed(/^Accept/));
    click(buttonNamed(/^Reject/));
    link.reconnect();
    expect(link.allSubmits()).toHaveLength(1);
    link.refuse("n1");
    await flush();
    expect(buttonNamed(/^Accept/).disabled).toBe(false);
    expect(buttonNamed(/^Reject/).disabled).toBe(false);
  });
});

/* ================================================================================================================ */
/*  The W2-G emergency modal (the `emergencyPurchaseW2G` v13 board: two holdings each too small alone)               */
/* ================================================================================================================ */

const hex = (label: string) => STATIC_BOARD_HEXES.find((entry) => entry.label === label)!;
const H16 = hex("H16");
const I17 = hex("I17");
const CORRIDOR = {
  game_id: 1,
  tiles: [
    { q: H16.q, r: H16.r, tile_id: 57, orientation: 2 },
    { q: I17.q, r: I17.r, tile_id: 7, orientation: 2 },
  ],
} as unknown as MapGridResponse;
const CO = 5;
const ENYC = 2;
const EPRR = 1;
const EP1 = "p1";
const cellOf = (price: number) => marketCellForPrice(price)!;
function twoHoldings(): GameStateResponse {
  const corps = [
    { id: CO, ticker: "C&O", president: EP1, trains: [] as string[], treasury: "0", holdings: [[EP1, 20], ["p2", 20]] as Array<[string, number]>, price: 90 },
    { id: ENYC, ticker: "NYC", president: "p2", trains: [], treasury: "500", holdings: [["p2", 30], [EP1, 10]] as Array<[string, number]>, price: 40 },
    { id: EPRR, ticker: "PRR", president: "p3", trains: [], treasury: "500", holdings: [["p3", 40], [EP1, 10]] as Array<[string, number]>, price: 50 },
  ];
  const order = corps.map((corp) => corp.id);
  const cash: Record<string, number> = { [EP1]: 0, p2: 300, p3: 300 };
  return {
    player_addresses: [EP1, "p2", "p3"],
    player_cash: [EP1, "p2", "p3"].map((player) => ({ player, cash_vgp: String(cash[player]) })),
    virtual_bank_vgp: "10000",
    variants: { rules: 2 },
    rules_engine_version: 13,
    private_companies: [],
    current_round_type: "OperatingRound",
    macro_round_number: 3,
    active_player_index: 0,
    active_operating_order: order,
    active_corporation_index: order.indexOf(CO),
    sub_round_index: 1,
    operating_round_sequence_length: 1,
    consecutive_passes: 0,
    operating_sub_phase: "Hardware",
    market_positions: Object.fromEntries(corps.map((corp, index) => [corp.id, { price: corp.price, x: cellOf(corp.price).x, y: cellOf(corp.price).y, enteredAt: index + 1 }])),
    public_companies: corps.map((corp) => ({
      company_id: corp.id, ticker: corp.ticker, is_floated: true, president: corp.president, par_value: String(corp.price),
      ipo_pool_percentage: 0, bank_pool_percentage: 0, treasury: corp.treasury, owned_trains: corp.trains,
      player_holdings: corp.holdings.map(([player, percentage]) => ({ player, percentage })),
      station_token_hexes: [[H16.q, H16.r]], station_tokens: [[H16.q, H16.r, 0]], station_token_limit: 3, home_hex_label: "F6",
    })),
  } as unknown as GameStateResponse;
}
const providers = sandboxReplayProviders();
const emergencyApply = (state: GameStateResponse, msg: Msg) =>
  applySandboxAction(state, msg as never, {
    actor: EP1, mapGrid: CORRIDOR, ...providers.chartInjections(state),
    marketContext: providers.marketContext(state, msg as never, EP1), parCellFor: providers.parCellFor,
  });

/** The shell's mount (`R-EMERG`), reduced: every prop from the board by the real helpers; `actionInFlight` the shell's. */
function emergencyProps(current: GameStateResponse, actionInFlight: boolean, press: ShellApi["press"]): EmergencyTrainPurchaseModalProps {
  const funding = emergencyFundingFor(current, CORRIDOR)!;
  return {
    plan: buildEmergencyPurchasePlan({ funding, stage: emergencyStageFor(current, funding), labelForAddress: (a) => a, privateOfferBuyerPresident: null }),
    sandbox: true,
    actionInFlight,
    labelForAddress: (a) => a,
    intercorporate: intercorporateStepFor(current, funding, CORRIDOR, EP1),
    intercorporateOfferRefusal: (draft) => intercorporateOfferRefusal(current, funding, CORRIDOR, EP1, draft),
    onProposeTrade: noop,
    onRescindTrade: noop,
    forgoTrade: { refusal: forgoTrainTradeRefusal(current, funding, EP1), consequence: decisionConsequenceFor(current, funding, CORRIDOR, "trade_window_closed") },
    onForgoTrainTrade: noop,
    portfolioVerdict: (draft) => portfolioVerdictFor(current, funding, EP1, draft),
    onSellPortfolio: (legs) => press({ EmergencySellPortfolio: { game_id: 1, sales: legs.map((leg) => ({ protocol_id: leg.protocol_id, percentage: leg.percentage })) } }),
    privateOfferRefusal: (draft) => fundingOfferDraftRefusal(current, funding, EP1, draft),
    onOfferPrivate: noop,
    onRescindPrivateOffer: noop,
    forgoPrivate: { refusal: forgoPrivateFundingRefusal(current, funding, EP1), consequence: decisionConsequenceFor(current, funding, CORRIDOR, "private_funding_forgone") },
    onForgoPrivateFunding: noop,
  };
}

describe("AUD-25.01 (10): the W2-G emergency action cannot duplicate", () => {
  const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-native-modal]");
  const select = (ariaLabel: string) => dialog()!.querySelector<HTMLSelectElement>(`select[aria-label="${ariaLabel}"]`)!;
  const choose = (node: HTMLSelectElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(node, value);
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const sell = () => buttonNamed(/^Sell the chosen shares/);

  it("the portfolio sale: held past the modal's 4 s and the shell's 6 s while queued, one message, re-armed on refusal", async () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    act(() =>
      root.render(
        <Shell link={link} initial={twoHoldings()} apply={emergencyApply}>
          {({ board, actionInFlight, press }) => <EmergencyTrainPurchaseModal {...emergencyProps(board, actionInFlight, press)} />}
        </Shell>,
      ),
    );
    choose(select("Shares of PRR to sell"), "10");
    choose(select("Shares of NYC to sell"), "10");
    expect(sell().disabled).toBe(false);
    click(sell());
    advance(LONG_PAST);
    expect(sell().disabled).toBe(true);
    expect(dialog()!.textContent).toContain(SENDING);
    click(sell());
    link.reconnect();
    expect(link.allSubmits().map((frame) => Object.keys(frame.msg as Msg)[0])).toEqual(["EmergencySellPortfolio"]);
    link.refuse("n1");
    await flush();
    expect(sell().disabled).toBe(false); // the board never moved; the link's answer released it
    expect(dialog()!.textContent).not.toContain(SENDING);
  });
});

/* ================================================================================================================ */
describe("AUD-25.01 (11): only THIS tab's held gameplay submission busies the controls", () => {
  it("an `automatic` press (the par answer, the M&H exchange, a home station, Undo) is latched and held by the link", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    let api: ShellApi | null = null;
    act(() =>
      root.render(
        <Shell link={link} initial={srBoard()} apply={srApply}>
          {(shell) => {
            api = shell;
            return <StockRoundShellControls shell={shell} />;
          }}
        </Shell>,
      ),
    );
    openCard("PRR");
    expect(sellButton()!.disabled).toBe(false);
    act(() => api!.press({ ExchangePrivate: { private_id: 1, company_id: 1, player: "p0", source: "Ipo" } }, { automatic: true }));
    expect(sellButton()!.disabled).toBe(true); // the board is stale until the exchange settles
    advance(LONG_PAST);
    expect(sellButton()!.disabled).toBe(true);
  });

  it("another player's move arriving is not this tab's submission: nothing greys", () => {
    const link = room();
    act(() => link.wire().open());
    mountStockRound(link);
    openCard("PRR");
    act(() =>
      link.wire().deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [{ index: 0, id: "e0", actor: "p-ben", payload: "{}" }] }),
    );
    expect(link.client.queue.unsettled).toBe(0);
    expect(sellButton()!.disabled).toBe(false);
    expect(passButton().disabled).toBe(false);
  });

  it("another seat's entry landing MID-HOLD releases the latch by index, but the link still keeps the controls busy", () => {
    const link = room();
    act(() => link.wire().open());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    // The server is still committing this tab's sale (LIVE-3A `unavailable`): the link holds it.
    act(() => link.wire().deliver({ kind: "refused", build: "build-1", code: "unavailable", reason: "Could not confirm.", inReplyTo: "n1" }));
    // Another seat's move arrives and the drain applies it: the press's index is passed, the latch is released...
    act(() =>
      link.wire().deliver({ kind: "applied", build: "build-1", digest: "0".repeat(16), entries: [{ index: 0, id: "e0", actor: "p-ben", payload: "{}" }] }),
    );
    act(() => link.drain());
    expect(prrHeld()).toBe(20); // the other seat's entry moved no share of this tab's
    // ...but the link still holds the sale, so nothing re-arms -- not now, and not past the backstop.
    expect(link.client.queue.unsettled).toBe(1);
    expect(sellButton()!.disabled).toBe(true);
    advance(LONG_PAST);
    expect(sellButton()!.disabled).toBe(true);
    click(sellButton());
    expect(link.allSubmits()).toHaveLength(1);
  });

  it("browsing is not acting: the cards open while the link holds a submission", () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    mountStockRound(link);
    openCard("PRR");
    click(sellButton());
    advance(LONG_PAST);
    const opener = host.querySelector<HTMLButtonElement>('button[aria-label="NYC — show share actions"]')!;
    expect(opener.disabled).toBe(false);
    click(opener);
    expect(sellButton()).toBeDefined(); // NYC's actions are shown (greyed), the card is not
  });

  it("a link that has ended leaves nothing held: the next table's controls are live", () => {
    const first = room();
    act(() => first.wire().open());
    act(() => first.wire().drop());
    act(() => {
      void first.client.submit(PASS as never);
    });
    expect(getActiveLinkQueue().unsettled).toBe(1);
    act(() => first.client.close());
    const link = room();
    act(() => link.wire().open());
    mountStockRound(link);
    openCard("PRR");
    expect(sellButton()!.disabled).toBe(false);
  });

  it("with no room link (the Firestore / hotseat path) the latch is #1173's as before: the 6 s backstop releases it", () => {
    let api: ShellApi | null = null;
    function NoLink() {
      const [pendingAppendIndex, setPendingAppendIndex] = useState<number | null>(null);
      const view = linkQueueView(useLinkQueue());
      const actionInFlight = useActionLatch(pendingAppendIndex, setPendingAppendIndex, view.blocked, BACKSTOP_MS);
      api = { board: srBoard(), actionInFlight, view, press: () => setPendingAppendIndex(0) };
      return <span data-testid="busy">{String(actionInFlight)}</span>;
    }
    act(() => root.render(<NoLink />));
    const busy = () => host.querySelector('[data-testid="busy"]')!.textContent;
    act(() => api!.press({}));
    expect(busy()).toBe("true");
    advance(BACKSTOP_MS - 1);
    expect(busy()).toBe("true");
    advance(1);
    expect(busy()).toBe("false");
  });

  it("the derivation: busy = a latched press OR a held submission; idle only when neither", () => {
    expect(actionLatchBusy(null, false)).toBe(false);
    expect(actionLatchBusy(3, false)).toBe(true);
    expect(actionLatchBusy(null, true)).toBe(true);
    expect(actionLatchBusy(3, true)).toBe(true);
  });
});

/** The Stocks tab alone, for a shell handed in by the test. */
function StockRoundShellControls({ shell }: { shell: ShellApi }) {
  const gates = srGates(shell.board, "p0");
  return (
    <StockRoundPanel
      publicCompanies={shell.board.public_companies}
      privateCompanies={shell.board.private_companies}
      parValueFor={() => "100"}
      onSelectParValue={noop}
      onBuyShare={noop}
      onSellShares={(protocolId, percentage) => shell.press(SELL(protocolId, percentage))}
      sessionReady
      isMyTurn
      actionInFlight={shell.actionInFlight}
      connectedAddress="p0"
      macroRoundNumber={shell.board.macro_round_number}
      playerCash={2000}
      marketPrices={{ [PRR]: 100, [NYC]: 90 }}
      roundType="StockRound"
      purchaseBlockFor={gates.purchaseBlockFor}
      saleBlockFor={gates.saleBlockFor}
    />
  );
}

/* ================================================================================================================ */
describe("AUD-25.01 (12): the offer forms and the par prompt keep W3-I's behaviour under the link-aware latch", () => {
  const board = () =>
    stockRoundBoard({
      corps: [{ id: OPRR, ticker: "PRR", president: OP1, trains: ["3"], treasury: "500", holdings: [[OP1, 30], [OP2, 20]], ipo: 50 }],
      privates: [
        { id: DH, owner: OP2, cost: "70" },
        { id: CA, owner: OP3, cost: "160" },
        { id: MH, owner: OP1, cost: "110" },
      ],
    });
  const q = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const labelFor = (address: string) => address;

  it("the Private Companies form still says QUEUED (the link's sentence first), takes no second press, and reopens on refusal", async () => {
    const link = room();
    act(() => link.wire().open());
    act(() => link.wire().drop());
    const current = board();
    act(() =>
      root.render(
        <Shell link={link} initial={current} apply={(b) => b}>
          {({ actionInFlight, view, press }) => (
            <PrivateCompaniesSection
              model={privateTradeSectionModel(current, OP1, labelFor)!}
              viewer={OP1}
              proposalRefusal={(intent) => privateTradeProposalRefusal(current, OP1, intent, labelFor)}
              onPropose={(intent) => press({ ProposePrivateTrade: intent as unknown as Msg })}
              onAnswer={noop}
              onRescind={noop}
              sessionReady
              actionInFlight={actionInFlight}
              linkQueue={view}
            />
          )}
        </Shell>,
      ),
    );
    click(q(`private-trade-buy-${DH}`));
    const input = q<HTMLInputElement>("private-trade-price")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "40");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(q("private-trade-send"));
    advance(LONG_PAST);
    expect(q("private-trade-refusal")?.textContent).toBe(LINK_QUEUED_NOTE);
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(true);
    click(q("private-trade-send"));
    link.reconnect();
    expect(link.allSubmits()).toHaveLength(1);
    link.refuse("n1");
    await flush();
    expect(q<HTMLInputElement>("private-trade-price")!.value).toBe("40");
    expect(q<HTMLButtonElement>("private-trade-send")!.disabled).toBe(false);
  });
});

/* ================================================================================================================ */
describe("the shell's wiring (source pins): one derived busy reason, read by every affected control; RED untouched", () => {
  const APP = readShell();
  it("derives `actionInFlight` from W3-I's one view through `useActionLatch`, with #1173's 6 s figure", () => {
    expect(APP).toContain(
      "const actionInFlight = useActionLatch(pendingAppendIndex, setPendingAppendIndex, linkQueueNote.blocked, ACTION_LATCH_BACKSTOP_MS);",
    );
    expect(APP).toContain("const ACTION_LATCH_BACKSTOP_MS = 6000;");
    expect(APP).not.toContain("const actionInFlight = pendingAppendIndex !== null;");
    // The latch is still the shell's own state (the RED setters keep their name); its one backstop is the hook's.
    expect(APP.split("const [pendingAppendIndex, setPendingAppendIndex] = useState<number | null>(null);").length - 1).toBe(1);
    expect(APP.split("ACTION_LATCH_BACKSTOP_MS").length - 1).toBe(2); // the declaration and the hook's argument
    // The hook is read once, before the latch, and never inside the link callbacks (W3-I's pin, kept).
    expect(APP.split("useLinkQueue()").length - 1).toBe(1);
    expectOrder(APP, "const [pendingAppendIndex, setPendingAppendIndex] = useState", "const linkQueueNote = useMemo(", "useActionLatch(pendingAppendIndex");
    expect(sliceBetween(APP, "const link = connectServerLink({", "serverLinkRef.current = link;")).not.toContain("useActionLatch");
  });

  it("every control AUD-25.01 names reads the one flag", () => {
    // The OR / Stock Round bar (and its Pass), the M&H off-turn chip, the Stocks tab (Buy / Sell), the waterfall cards.
    expect(APP).toContain("sessionReady={controlsEnabled && isMyTurn && !actionInFlight}");
    expect(APP).toContain("offTurnPowerReady={controlsEnabled && !actionInFlight && !scrubbing}");
    expect(sliceBetween(APP, "<StockRoundPanel", "/>")).toContain("actionInFlight={actionInFlight}");
    // The W2-G emergency modal.
    expect(sliceBetween(APP, "<EmergencyTrainPurchaseModal", "labelForAddress=")).toContain("actionInFlight={actionInFlight}");
    // The consent prompts.
    for (const prompt of ["<TrainTradePrompt", "<TrainDiscardPrompt", "<PrivateTradePrompt", "<FundingPrivateOfferPrompt"]) {
      expect(sliceBetween(APP, prompt, "/>")).toContain("actionInFlight={actionInFlight}");
    }
    expect(sliceBetween(APP, "<PlayerPrivateTradePrompt", "/>")).toContain(": actionInFlight");
    // The ring's tick.
    expect(APP).toContain("inFlight: actionInFlight || previewTile?.committed === true,");
  });

  it("the RED R1 submit half and the R5 drain release (the setter keeps its name and lines; P3-N021's R1 latch rule)", () => {
    expect(APP).toContain("if (options?.derived !== true) setPendingAppendIndex(appendAt);");
    expect(APP).toContain("setPendingAppendIndex((current) => (current === appendAt ? null : current));");
    expect(APP).toContain("current !== null && appliedIndexRef.current > current ? null : current,");
  });

  it("the hook: the backstop waits for the link, and the busy answer is the latch OR the link", () => {
    const LATCH = readStripped("utils/actionLatch.ts");
    expect(LATCH).toContain("return pendingAppendIndex !== null || linkHolds;");
    expect(LATCH).toContain("if (pendingAppendIndex === null || linkHolds) return undefined;");
    expect(LATCH).not.toMatch(/\bsubmit\(|connectServerLink|getActiveLinkQueue/); // reads; never sends or re-queues
  });
});
