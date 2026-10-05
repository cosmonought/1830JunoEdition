/** @jest-environment jsdom */
/**
 * Phase 3 W3-B — THE LATCH RESIDUE: AUD-14.06 (latch coverage) and P3-N021 (the automatic presses).
 *
 * W3-B's AUD-25.01 made the room link's queue the long-duration guard (`useActionLatch`): `actionInFlight` is busy while
 * a press is latched OR the link still holds one of this tab's submissions, and the 6 s backstop waits for the link.
 * This suite closes the two rows that slice left open, ON THAT ONE FLAG -- no second busy state:
 *
 *   P3-N021 (OD-12 RED R1, its own commit): every player press takes the latch -- the `automatic`-flagged decisions
 *     (the B&O par, Proceed, the M&H exchange, a home / D&H station, Undo, Close Room) too -- and the server-path
 *     `derived` return no longer releases a player's held press. The auto-pass / auto-buy effects wait for the press
 *     in flight. The W3-J catching-up gate still precedes all of it.
 *   AUD-14.06: the surfaces that still dispatched without reading the flag -- BuyLicenseModal, PrivatePowerFlowModal,
 *     the auction prompt (par + Proceed), the token confirm, Undo and the map's route edits -- read it now; and a
 *     COVERAGE REGISTRY accounts for every `runGameplayAction` call site in the shell (enumerated from the AST, not
 *     from a list): each is LATCHED (with the source evidence that its every door reads the flag) or EXEMPT (with a
 *     precise reason). A new call site fails the registry until it is classified.
 *
 * The behaviour tests run against the REAL link (`connectServerLink`) over a hand-driven socket, read through the REAL
 * hooks (`useLinkQueue`, `useActionLatch`, `actionLatchReason`) and rendered through the REAL surfaces. The shell's
 * dispatch is reduced to the latch lines `runGameplayAction` runs (RED R1 after P3-N021) and the drain's index release
 * (RED R5, unchanged) -- both pinned against App.tsx at the bottom, as W3-B's own suite pins them.
 */
import React, { act, useCallback, useRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import ContextualActionBar from "../panels/ContextualActionBar";
import { ModalLayerHost } from "./ModalPortal";
import { BuyLicenseModal } from "./BuyLicenseModal";
import { PrivatePowerFlowModal } from "./PrivatePowerFlowModal";
import { AuctionPromptModal } from "./AuctionPromptModal";
import { RadialTokenConfirm } from "./RadialTileSelector";
import type { TrainRouteDraft } from "./RoutePlannerPanel";
import type { RoundType } from "../gameEngine/gameState";
import { privatePowerFlow } from "../utils/privatePowerFlow";
import { connectServerLink, type LinkQueueState, type ServerLink, type SocketLike } from "../utils/serverLink";
import { LINK_QUEUED_NOTE, LINK_SENDING_NOTE, linkQueueView, useLinkQueue, type LinkQueueView } from "../utils/useLinkQueue";
import { actionLatchReason, useActionLatch } from "../utils/actionLatch";
import {
  discoverSources,
  expectOrder,
  readShell,
  readSource,
  readStripped,
  shellSourcePaths,
  sliceBetween,
} from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/** App.tsx's `ACTION_LATCH_BACKSTOP_MS` (pinned in W3-B's suite and `doubleActionWindow`). */
const BACKSTOP_MS = 6000;
/** Well past the backstop, the par prompt's own hold and the emergency modal's 4 s press latch. */
const LONG_PAST = BACKSTOP_MS * 3;
const noop = () => undefined;
type Msg = Record<string, unknown>;

/* ---- a real link over hand-driven sockets (the W3-I / W3-B harness) --------------------------------------------- */

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

interface Room {
  client: ServerLink;
  wire: () => Wire;
  inbox: Array<{ index: number; submission_id?: string }>;
  reconnect: () => void;
  allSubmits: () => Array<Record<string, unknown>>;
  /** The message kinds every submit frame on any socket carried, in order. */
  kinds: () => string[];
  land: (submissionId: string, index: number) => void;
  /** Another seat's move: an applied frame answering nobody on this tab. */
  otherSeat: (index: number) => void;
  refuse: (submissionId: string) => void;
  drain: () => void;
}

const links: ServerLink[] = [];
function room(): Room {
  const wires: Wire[] = [];
  const timers: Array<() => void> = [];
  const inbox: Room["inbox"] = [];
  let ids = 0;
  const client = connectServerLink({
    url: "ws://test",
    gameId: "g_0123456789abcdefghjkmnpqr0",
    build: "build-1",
    onEntries: (entries) => {
      inbox.push(...(entries as unknown as Room["inbox"]));
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
  const allSubmits = () => wires.flatMap((w) => w.frames().filter((frame) => frame.kind === "submit"));
  return {
    client,
    wire,
    inbox,
    reconnect: () => {
      for (const callback of timers.splice(0)) callback();
      act(() => wire().open());
    },
    allSubmits,
    kinds: () => allSubmits().map((frame) => Object.keys(frame.msg as Msg)[0]),
    land: (submissionId, index) =>
      act(() =>
        wire().deliver({
          kind: "applied",
          build: "build-1",
          digest: "0".repeat(16),
          entries: [{ index, id: `e${index}`, actor: "p0", payload: "{}", submission_id: submissionId }],
          inReplyTo: submissionId,
        }),
      ),
    otherSeat: (index) =>
      act(() =>
        wire().deliver({
          kind: "applied",
          build: "build-1",
          digest: "0".repeat(16),
          entries: [{ index, id: `e${index}`, actor: "p1", payload: "{}" }],
        }),
      ),
    refuse: (submissionId) =>
      act(() => wire().deliver({ kind: "refused", build: "build-1", reason: "Not now.", inReplyTo: submissionId })),
    drain: noop,
  };
}

/* ---- the shell, reduced to its latch -------------------------------------------------------------------------------- */

interface PressOptions {
  automatic?: boolean;
  derived?: boolean;
}
interface ShellApi {
  actionInFlight: boolean;
  /** The one sentence for the one flag (`actionLatchReason`), as App.tsx derives `actionInFlightReason`. */
  reason: string | null;
  view: LinkQueueView;
  queue: LinkQueueState;
  press: (msg: Msg, options?: PressOptions) => void;
  /** How many entries the drain has applied (the board's stand-in: the surfaces here are judged by the latch alone). */
  applied: number;
}

/** The shell's composition after P3-N021: W3-I's hook and view, W3-B's latch, `actionLatchReason`, the submit half's
 *  latch lines (RED R1) and the drain's index release (RED R5). */
function Shell({ link, children }: { link: Room; children: (api: ShellApi) => React.ReactNode }) {
  const [pendingAppendIndex, setPendingAppendIndex] = useState<number | null>(null);
  const queue = useLinkQueue();
  const view = linkQueueView(queue);
  const actionInFlight = useActionLatch(pendingAppendIndex, setPendingAppendIndex, view.blocked, BACKSTOP_MS);
  const reason = actionLatchReason(actionInFlight, view);
  const appliedIndexRef = useRef(0);
  const [applied, setApplied] = useState(0);
  const press = useCallback(
    (msg: Msg, options?: PressOptions) => {
      const appendAt = appliedIndexRef.current;
      // RED R1 (P3-N021): every press but a `derived` one takes the latch.
      if (options?.derived !== true) setPendingAppendIndex(appendAt);
      // RED R1 (P3-N021): the server-path derived return touches no latch (it took none).
      if (options?.derived === true) return;
      void link.client.submit(msg as never).then((allocated) => {
        if (allocated === null) setPendingAppendIndex((current) => (current === appendAt ? null : current));
      });
    },
    [link],
  );
  link.drain = () => {
    const entries = link.inbox.splice(0);
    appliedIndexRef.current += entries.length;
    setApplied((count) => count + entries.length);
    // RED R5, unchanged: released against the index the latch was taken at.
    setPendingAppendIndex((current) => (current !== null && appliedIndexRef.current > current ? null : current));
  };
  return <>{children({ actionInFlight, reason, view, queue, press, applied })}</>;
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
const byTestId = (id: string): HTMLButtonElement | null => document.body.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const must = <T extends Element>(node: T | null, what: string): T => {
  if (!node) throw new Error(`missing ${what}`);
  return node;
};

/** An open, connected link; `down` drops the socket so presses queue (the network-loss case). */
function liveRoom(down = false): Room {
  const link = room();
  act(() => link.wire().open());
  if (down) act(() => link.wire().drop());
  return link;
}

/* ---- surface mounts, composed exactly as App.tsx composes them (pinned at the bottom) ------------------------------ */

const KANAWHA: Msg = { BuyKanawhaLicense: { protocol_id: 1 } };
const EXCHANGE: Msg = { ExchangePrivate: { private_id: 3, company_id: 3, player: "p0", source: "Ipo" } };
const SET_PAR: Msg = { SetBoPar: { player: "p0", par_value: "100" } };
const PROCEED: Msg = { OpenStockRound: {} };
const PLACE_TOKEN: Msg = { PlaceStationToken: { game_id: 1, protocol_id: 1, q: 3, r: 4 } };
const PLACE_HOME: Msg = { PlaceHomeStation: { company_id: 1, q: 3, r: 4, kind: "home", city_index: 0, hex_label: "H12" } };
const REVERT: Msg = { RevertTo: { index: 0, player: "p0", summary: "the last share sale" } };
const RUN: Msg = { RunMultipleRoutes: { game_id: 1, protocol_id: 1, routes: [["H12", "I13"]] } };
const SKIP: Msg = { AdvanceOperatingSubPhase: { game_id: 1, protocol_id: 1 } };
const WITHHOLD: Msg = { DeclareDividends: { game_id: 1, protocol_id: 1, revenue_amount: "0", distribute: false } };
const SELL: Msg = { SellStock: { game_id: 1, protocol_id: 1, percentage: 10 } };

/** The licence modal as App.tsx mounts it: open while the shell says so, `inFlightReason={actionInFlightReason}`. */
function LicenseHarness({ shell }: { shell: ShellApi }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="open-licence" onClick={() => setOpen(true)}>
        open
      </button>
      <BuyLicenseModal
        open={open}
        onClose={() => setOpen(false)}
        actingTicker="PRR"
        remaining={3}
        alreadyHeld={false}
        refusal={null}
        treasuryBefore={500}
        onBuy={() => shell.press(KANAWHA)}
        inFlightReason={shell.reason}
      />
    </>
  );
}

/** The M&H flow as App.tsx mounts it: the act runs the exchange (`automatic`), and closes the modal only if it fired. */
function PowerFlowHarness({ shell }: { shell: ShellApi }) {
  const [open, setOpen] = useState(true);
  const flow = privatePowerFlow({
    abilityKey: "mh-exchange",
    holder: "Ann",
    revenuePerOr: 20,
    sources: [
      { source: "Ipo", refusal: null },
      { source: "Bank", refusal: null },
    ],
  });
  return (
    <>
      <button type="button" data-testid="open-flow" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <PrivatePowerFlowModal
          flow={flow}
          ticker="PRR"
          tokensLeft={2}
          onAct={() => {
            shell.press(EXCHANGE, { automatic: true });
            setOpen(false);
          }}
          onDecline={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          inFlightReason={shell.reason}
        />
      )}
    </>
  );
}

/** The auction prompt as App.tsx mounts it: the par press returns the submission; both answers are `automatic`. */
function AuctionHarness({ shell, par }: { shell: ShellApi; par: boolean }) {
  return (
    <AuctionPromptModal
      parPending={par}
      parWinnerLabel="Ann"
      onConfirmPar={() => {
        shell.press(SET_PAR, { automatic: true });
        return Promise.resolve();
      }}
      handoffPending={!par}
      awaitingParFrom={null}
      onProceed={() => shell.press(PROCEED, { automatic: true })}
      viewerActsOnHandoff
      linkQueue={shell.queue}
      inFlightReason={shell.reason}
    />
  );
}

/** The token confirm as App.tsx mounts it: `canConfirm={controlsEnabled && pendingTokenHold === null && !actionInFlight}`,
 *  the reason last in the precedence, and the press guarded at the mount. `free` sends `PlaceHomeStation` (`automatic`). */
function TokenHarness({ shell, free }: { shell: ShellApi; free: boolean }) {
  const [staged, setStaged] = useState(true);
  const controlsEnabled = true;
  const pendingTokenHold: string | null = null;
  return (
    <>
      <button type="button" data-testid="stage-token" onClick={() => setStaged(true)}>
        stage
      </button>
      {staged && (
        <RadialTokenConfirm
          anchorOffsetX={0}
          anchorOffsetY={0}
          canvasEl={null}
          hexLabel="H12"
          cost={free ? 0 : 40}
          ticker="PRR"
          liveryColor="#0f0f0f"
          liveryInk="#ffffff"
          canConfirm={controlsEnabled && pendingTokenHold === null && !shell.actionInFlight}
          confirmDisabledReason={
            !controlsEnabled ? "Initialize the session key to place a token." : (pendingTokenHold ?? shell.reason ?? undefined)
          }
          onConfirm={() => {
            if (!shell.actionInFlight) {
              setStaged(false); // `handleConfirmTokenPlacement` closes the ring at once
              shell.press(free ? PLACE_HOME : PLACE_TOKEN, free ? { automatic: true } : undefined);
            }
          }}
          onCancel={() => setStaged(false)}
        />
      )}
    </>
  );
}
const tokenTick = () => must(document.body.querySelector<HTMLButtonElement>('button[aria-label="Confirm station token placement"]'), "token tick");

type BarProps = ComponentProps<typeof ContextualActionBar>;
const CORP: NonNullable<BarProps["activeCorporation"]> = {
  companyId: 1, ticker: "PRR", fullName: "Pennsylvania Railroad", homeHexLabel: "H12", privates: [], presidentLabel: "Ann",
  presidentAddress: "p0", presidentColor: null, treasury: 500, stationSlots: [], trains: ["3"], reprievedTrains: [],
  finalRunSchedule: { thisTurn: [], nextTurn: [], doomedThisTurn: false }, ghostTrains: [], carcosanTrains: [], isCarcosan: false,
};
const DRAFT: TrainRouteDraft = {
  trainIndex: 0, model: "3", maxDistance: 3, hexLabels: ["H12", "I13"], stops: [{ hex: "H12", value: 30 }, { hex: "I13", value: 20 }],
  value: 50, revenueCentres: 2, exceedsMaxDistance: false, endsOffTerminus: false, tokenBlockReason: null,
} as TrainRouteDraft;

/** The bar as App.tsx mounts it: `sessionReady={controlsEnabled && isMyTurn && !actionInFlight}`, and Undo greyed by
 *  `undoBlockedReason`, whose last arm is `actionInFlightReason` (the reach is assumed to allow an Undo here). */
function barProps(shell: ShellApi, round: RoundType, sub: BarProps["orSubPhase"], extra: Partial<BarProps> = {}): BarProps {
  return {
    roundType: round,
    orSubPhase: sub,
    sessionReady: true && !shell.actionInFlight,
    offTurnPowerReady: !shell.actionInFlight,
    isMyTurn: true,
    onPassTurn: noop,
    passDisabledReason: null,
    turnHoldReason: null,
    turnActionTaken: false,
    onPlaceStationTokenHint: noop, stationTokenCost: 40, activeCorporation: round === "OperatingRound" ? CORP : null,
    onSkipSubPhase: () => shell.press(SKIP), onOpenPrivateTrade: noop,
    ownsAnyTrain: true, mustBuyTrain: false, activePlayerName: "Ann", activePlayerCash: 2000, activePlayerEscrow: 0,
    privateCompanies: [], onRunTrains: () => shell.press(RUN), onPayDividends: noop, onWithholdRevenue: noop, dividendRevenue: 0,
    dividendRevenueIsThisTurn: false, dividendPerShare: 0, dividendPayouts: [], rustOutlookForBar: null, dividendPrice: null,
    payProjection: null, withholdProjection: null, selectedHardwareModel: "2", onEndOperatingTurn: noop,
    onUndoLastAction: () => shell.press(REVERT, { automatic: true }),
    undoBlockedReason: shell.reason,
    onAutoRoute: noop, onSelectRouteTrain: noop, highlightedRouteIndex: null, onHighlightRoute: noop, trainDrafts: [],
    activeTrainIndex: 0, routeFeedback: null, onClearRoute: noop, currentGlobalEra: null, maxRouteRevenue: 50,
    ...extra,
  } as BarProps;
}

/* ================================================================================================================ */
/*  AUD-14.06: THE DISPATCH-SITE COVERAGE REGISTRY                                                                    */
/* ================================================================================================================ */

/** A fact the classification rests on: `text` is present in the source named (comment-stripped), optionally only
 *  within the slice between two anchors. */
interface Evidence {
  file: "shell" | string;
  within?: [string, string];
  text: string;
}
interface CallSiteEntry {
  /** `enclosing binding chain :: message`, as the enumerator below derives it. */
  key: string;
  /** How many call sites carry this key (default 1). */
  count?: number;
  verdict: "latched" | "exempt";
  /** Every door that reaches the call, and how it is latched -- or why it needs no latch. */
  why: string;
  evidence: Evidence[];
}

const SENDING_LAST = "sessionReady={controlsEnabled && isMyTurn && !actionInFlight}";
const BAR: Evidence = { file: "shell", text: SENDING_LAST };
const SR_PANEL: Evidence = { file: "shell", within: ["<StockRoundPanel", "/>"], text: "actionInFlight={actionInFlight}" };
const SR_PANEL_FLAG: Evidence = {
  file: "components/StockRoundPanel.tsx",
  text: "!sessionReady || actionsLockedReason != null || !isMyTurn || actionInFlight || offerHoldReason != null",
};
const EMERGENCY: Evidence = { file: "shell", within: ["<EmergencyTrainPurchaseModal", "labelForAddress="], text: "actionInFlight={actionInFlight}" };
const EMERGENCY_LATCH: Evidence = { file: "components/EmergencyTrainPurchaseModal.tsx", text: "const latched = pressed || actionInFlight;" };
const TOKEN_RING: Evidence = { file: "shell", text: "canConfirm={controlsEnabled && pendingTokenHold === null && !actionInFlight}" };
const TOKEN_RING_PRESS: Evidence = {
  file: "shell",
  within: ["<RadialTokenConfirm", "/>"],
  text: "if (!actionInFlight) handleConfirmTokenPlacement();",
};
const TILE_RING: Evidence = { file: "shell", text: "inFlight: actionInFlight || previewTile?.committed === true," };
const TILE_RING_PRESS: Evidence = { file: "shell", text: "if (ringConfirm.canConfirm) handleConfirmRadialLay();" };
const TRAIN_PANEL: Evidence = { file: "panels/ContextualActionBar.tsx", within: ["<TrainPurchasePanel", "/>"], text: "sessionReady={sessionReady}" };

const REGISTRY: CallSiteEntry[] = [
  {
    key: "onBuy < kanawhaLicenseControl :: BuyKanawhaLicense",
    verdict: "latched",
    why:
      "The one door is BuyLicenseModal's Buy (the bar's licence chip only OPENS the modal, #1388, and greys on sessionReady); " +
      "the Buy is disabled -- and guarded at the press -- while `actionInFlightReason` is set (AUD-14.06).",
    evidence: [
      { file: "shell", text: "kanawhaLicenseControl ? { ...kanawhaLicenseControl, onBuy: openLicenseModal } : kanawhaLicenseControl" },
      { file: "shell", within: ["<BuyLicenseModal", "/>"], text: "inFlightReason={actionInFlightReason}" },
      { file: "components/BuyLicenseModal.tsx", text: "disabled={inFlightReason !== null}" },
      { file: "components/BuyLicenseModal.tsx", text: "if (inFlightReason !== null) return;" },
    ],
  },
  {
    key: "closeRoom :: CloseRoom",
    verdict: "exempt",
    why:
      "Post-game and idempotent by rule (#899): any seat may close a finished room, the first CloseRoom closes it, and a " +
      "later one changes nothing (at most an unchanged no-op entry) -- a duplicate cannot change the game. Its live doors " +
      "are the GameOver modal's Close Room (`onCloseRoom={roomClosed ? null : () => closeRoom(\"manual\")}`, which reads " +
      "no latch) and the auto-close timer, which fires once per seat by design (LIVE-2 §9.3; the remaining time clamps at " +
      "0). At GameEnd the action bar is replaced by the game-over strip. The press itself takes the latch since P3-N021 " +
      "(`automatic`, not `derived`).",
    evidence: [
      { file: "shell", text: 'void runGameplayActionRef.current?.("closing the room", { CloseRoom: {} }, { automatic: true });' },
      { file: "shell", text: 'onCloseRoom={roomClosed ? null : () => closeRoom("manual")}' },
    ],
  },
  {
    key: "handleProceedToStockRound :: OpenStockRound",
    verdict: "latched",
    why:
      "The one live door is the auction prompt's Proceed, disabled -- and guarded at the press -- while " +
      "`actionInFlightReason` is set. WaterfallAuctionDashboard accepts an `onProceedToStockRound` prop but renders no " +
      "control for it. The press is `automatic` and takes the latch since P3-N021.",
    evidence: [
      { file: "shell", within: ["<AuctionPromptModal", "/>"], text: "onProceed={handleProceedToStockRound}" },
      { file: "shell", within: ["<AuctionPromptModal", "/>"], text: "inFlightReason={actionInFlightReason}" },
      { file: "components/AuctionPromptModal.tsx", text: "disabled={inFlightReason !== null}" },
    ],
  },
  {
    key: "runPrivateExchange :: ExchangePrivate",
    verdict: "latched",
    why:
      "Reached only from `handlePowerFlowAct` -- PrivatePowerFlowModal's act buttons, disabled and guarded while " +
      "`actionInFlightReason` is set; the M&H chip that opens the modal reads offTurnPowerReady (W2-D / W3-B). `automatic`, " +
      "so it takes the latch since P3-N021.",
    evidence: [
      { file: "shell", within: ["const handlePowerFlowAct = useCallback(", "const handlePowerFlowDecline"], text: "runPrivateExchange(exchangeSource" },
      { file: "shell", within: ["<PrivatePowerFlowModal", "/>"], text: "inFlightReason={actionInFlightReason}" },
      { file: "components/PrivatePowerFlowModal.tsx", text: "disabled={!step.enabled || inFlightReason !== null}" },
      { file: "shell", text: "offTurnPowerReady={controlsEnabled && !actionInFlight && !scrubbing}" },
    ],
  },
  {
    key: "runGameplayAction :: YellowSignEvent",
    count: 3,
    verdict: "exempt",
    why:
      "A follow-on dispatch from INSIDE the apply half (RED R2) of an applied RunMultipleRoutes, on a legacy unpinned " +
      "board only (`!signPinned`; unreachable on a pinned table) -- no control reaches it. In a room it runs inside the " +
      "drain, where W3-J's catching-up gate refuses it before the latch line; with no room (local play) it applies at " +
      "once and takes no latch. Silent in the log (#1375).",
    evidence: [{ file: "shell", text: "if (!signPinned) {" }],
  },
  {
    key: "handlePassTurn :: PassTurn",
    verdict: "latched",
    why:
      "Doors: the bar's Pass (sessionReady), End Turn via `handleEndOperatingTurn` (a bar button, sessionReady), and the " +
      "Auto-Pass effect, which now waits while a press is in flight (P3-N021).",
    evidence: [
      BAR,
      { file: "shell", text: "onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}" },
      { file: "shell", within: ["const handleEndOperatingTurn = useCallback(", "setLiveOrSubPhase(\"Track\");"], text: "handlePassTurn()" },
      { file: "shell", within: ["if (autoPassArm.player !== viewerAddress) return;", "void handlePassTurn();"], text: "if (actionInFlight) return;" },
    ],
  },
  {
    key: "handleUndoLastAction :: UndoLastAction",
    verdict: "latched",
    why: "The chain-path Undo: the bar's Undo buttons are disabled on `undoBlockedReason`, whose live arm is `actionInFlightReason`.",
    evidence: [
      { file: "shell", text: 'if (!sandbox) return controlsEnabled ? actionInFlightReason : "Initialize the session key to act.";' },
      { file: "panels/ContextualActionBar.tsx", text: "disabled={undoBlockedReason !== null}" },
    ],
  },
  {
    key: "handleUndoLastAction :: RevertTo",
    verdict: "latched",
    why:
      "The room Undo (`automatic`, so it takes the latch since P3-N021): both bar Undo buttons are disabled on " +
      "`undoBlockedReason`, which answers `actionInFlightReason` whenever the reach would allow an Undo (AUD-14.06).",
    evidence: [
      { file: "shell", text: 'return reach.index === null ? (reach.blockedReason ?? "There is nothing to undo.") : actionInFlightReason;' },
      { file: "shell", text: "undoBlockedReason={undoBlockedReason}" },
      { file: "panels/ContextualActionBar.tsx", text: "disabled={undoBlockedReason !== null}" },
    ],
  },
  {
    key: "buyOneShare :: BuyStock",
    verdict: "latched",
    why: "Doors: the Stocks tab's Buy (the panel's one flag carries actionInFlight) and the Auto-Buy effect, which now waits while a press is in flight (P3-N021).",
    evidence: [
      SR_PANEL,
      SR_PANEL_FLAG,
      { file: "shell", within: ["if (autoBuyPlan.player !== viewerAddress) return;", "const sent = buyOneShare("], text: "if (actionInFlight) return;" },
    ],
  },
  {
    key: "answer < commitFreeStationPlacement :: PlaceHomeStation",
    verdict: "latched",
    why:
      "Reached only from the token confirm's tick for a FREE placement (the home station, the D&H's): the tick's canConfirm " +
      "carries !actionInFlight and the mount guards the press (AUD-14.06). `automatic`, so it takes the latch since P3-N021; " +
      "W3-J's in-flight marker still keeps the home prompt from re-asking.",
    evidence: [
      { file: "shell", within: ["const handleConfirmTokenPlacement = useCallback(", "setTokenTargetMode(false);"], text: "commitFreeStationPlacement({ q, r, cityIndex })" },
      TOKEN_RING,
      TOKEN_RING_PRESS,
    ],
  },
  {
    key: "handleConfirmBoPar :: SetBoPar",
    verdict: "latched",
    why:
      "The auction prompt's par confirm: held by its own W3-I link hold AND, since AUD-14.06, by `actionInFlightReason` " +
      "(`confirmHeld = ownHold || inFlightReason !== null`). `automatic`, so it takes the latch since P3-N021.",
    evidence: [
      { file: "shell", within: ["<AuctionPromptModal", "/>"], text: "onConfirmPar={handleConfirmBoPar}" },
      { file: "components/AuctionPromptModal.tsx", text: "const confirmHeld = ownHold || inFlightReason !== null;" },
    ],
  },
  { key: "handleBuyDoubleCertificate :: BuyStock", verdict: "latched", why: "The Stocks tab's double-certificate Buy (the panel's one flag, actionInFlight).", evidence: [SR_PANEL, SR_PANEL_FLAG] },
  { key: "handleSellShares :: SellStock", verdict: "latched", why: "The Stocks tab's Sell (the panel's one flag, actionInFlight).", evidence: [SR_PANEL, SR_PANEL_FLAG] },
  {
    key: "runAnswer < handleRunTrains :: RunMultipleRoutes",
    verdict: "latched",
    why:
      "The bar's Run Trains (RunRoutesButton, `controlsEnabled={sessionReady}`). The route edits that feed it are latched " +
      "too (AUD-14.06): the chip's Clear / remove-stop / bypass need `canClear = mayActThisTurn && sessionReady`, Auto-Route " +
      "reads sessionReady, and the map's route clicks are consumed while a press is in flight.",
    evidence: [
      BAR,
      { file: "panels/ContextualActionBar.tsx", within: ["<RunRoutesButton", "/>"], text: "controlsEnabled={sessionReady}" },
      { file: "panels/ContextualActionBar.tsx", text: "canClear={mayActThisTurn && sessionReady}" },
      { file: "shell", text: "? ROUTE_EDIT_WHILE_IN_FLIGHT" },
    ],
  },
  {
    key: "declareDividendsChoice :: DeclareDividends",
    verdict: "latched",
    why:
      "Pay / Withhold are bar buttons (sessionReady). Its `automatic` entry (`withholdRevenueAutomatically`, the forced $0 " +
      "withhold) is `derived` -- the game's own action: never sent on the server path (#1213), no latch taken and, since " +
      "P3-N021, none released; its effect lives in RED R4.",
    evidence: [BAR, { file: "shell", within: ["const declareDividendsChoice = useCallback(", "setLiveOrSubPhase(\"Hardware\");"], text: "{ automatic, derived: automatic }" }],
  },
  { key: "handleBuyTrainsFromBank :: BuyHardwareFromPool", verdict: "latched", why: "The Buy Trains panel's depot Buy, rendered by the bar with its sessionReady.", evidence: [BAR, TRAIN_PANEL, { file: "components/TrainPurchasePanel.tsx", text: "disabled={bankProblem !== null || !sessionReady || !canAct}" }] },
  { key: "handleExchangeForDiesel :: ExchangeTrainForDiesel", verdict: "latched", why: "The Buy Trains panel's Diesel trade-in (sessionReady).", evidence: [BAR, TRAIN_PANEL, { file: "components/TrainPurchasePanel.tsx", text: "disabled={dieselExchange.problem !== null || !sessionReady || !canAct || !exchangeChoice}" }] },
  { key: "handleBuyReturnedTrain :: BuyHardwareFromPool", verdict: "latched", why: "The Buy Trains panel's returned-train Buy (sessionReady).", evidence: [BAR, TRAIN_PANEL, { file: "components/TrainPurchasePanel.tsx", text: "disabled={train.problem !== null || !sessionReady || !canAct}" }] },
  {
    key: "handleProposePrivatePurchase :: BuyPrivateCompany",
    verdict: "latched",
    why: "The bar's private-purchase sheet: W2-C's submit reads the shell's actionInFlight and W3-I's link queue.",
    evidence: [{ file: "shell", within: ["privatePurchase={", "onOpenPrivateTrade="], text: "actionInFlight," }],
  },
  {
    key: "handleProposePrivatePurchase :: ProposePrivatePurchase",
    verdict: "latched",
    why: "The same sheet (W2-C), one handler, two messages by deployment.",
    evidence: [{ file: "shell", within: ["privatePurchase={", "onOpenPrivateTrade="], text: "actionInFlight," }],
  },
  ...(["handleAcceptPrivateOffer", "handleRejectPrivateOffer"] as const).map(
    (name): CallSiteEntry => ({
      key: `${name} :: AnswerPrivatePurchase`,
      verdict: "latched",
      why: "PrivateTradePrompt's answer (`offTurn`), greyed on the shell's actionInFlight (W1-D / AUD-25.01).",
      evidence: [{ file: "shell", within: ["<PrivateTradePrompt", "/>"], text: "actionInFlight={actionInFlight}" }],
    }),
  ),
  {
    key: "handleRescindPrivateOffer :: RescindPrivatePurchase",
    verdict: "latched",
    why: "PrivateTradePrompt's Rescind, greyed on actionInFlight.",
    evidence: [
      { file: "shell", within: ["<PrivateTradePrompt", "/>"], text: "actionInFlight={actionInFlight}" },
      { file: "components/PrivateTradePanel.tsx", text: "disabled={actionInFlight}" },
    ],
  },
  {
    key: "handleProposePrivateTrade :: proposePrivateTradeMsg",
    verdict: "latched",
    why: "The Stocks tab's Private Companies offer form (actionInFlight + W3-I link queue).",
    evidence: [SR_PANEL, { file: "components/StockRoundPanel.tsx", text: "actionInFlight={actionInFlight}" }],
  },
  {
    key: "handleAnswerPrivateTrade :: answerPrivateTradeMsg",
    verdict: "latched",
    why: "The Private Companies card (actionInFlight) and the fixed PlayerPrivateTradePrompt (answerBlockedReason carries actionInFlight).",
    evidence: [SR_PANEL, { file: "shell", within: ["<PlayerPrivateTradePrompt", "/>"], text: ": actionInFlight" }],
  },
  {
    key: "handleRescindPrivateTrade :: rescindPrivateTradeMsg",
    verdict: "latched",
    why: "The same two surfaces; the prompt's Rescind is disabled on answerBlockedReason.",
    evidence: [SR_PANEL, { file: "shell", within: ["<PlayerPrivateTradePrompt", "/>"], text: ": actionInFlight" }, { file: "components/PrivateCompaniesSection.tsx", text: "disabled={answerBlockedReason !== null}" }],
  },
  ...([
    ["handleWaterfallBuyLowest", "WaterfallBuyLowest"],
    ["handleWaterfallBidHigher", "WaterfallBidHigher"],
    ["handleWaterfallMiniAuctionRaise", "WaterfallMiniAuctionRaise"],
    ["handleWaterfallMiniAuctionPass", "WaterfallMiniAuctionPass"],
  ] as const).map(
    ([name, msg]): CallSiteEntry => ({
      key: `${name} :: ${msg}`,
      verdict: "latched",
      why: "The auction dashboard's card controls: `sessionReady={controlsEnabled && !actionInFlight && !scrubbing}` (W1-B).",
      evidence: [{ file: "shell", text: "sessionReady={controlsEnabled && !actionInFlight && !scrubbing}" }],
    }),
  ),
  {
    key: "handleWaterfallPass :: WaterfallPass",
    verdict: "latched",
    why: "The bar's Pass during the auction (sessionReady).",
    evidence: [BAR, { file: "shell", text: "onPassTurn={isWaterfallPhase ? handleWaterfallPass : handlePassTurn}" }],
  },
  {
    key: "placed < handleConfirmTokenPlacement :: PlaceStationToken",
    verdict: "latched",
    why: "The token confirm's tick: canConfirm carries !actionInFlight with the reason last, and the mount guards the press (AUD-14.06).",
    evidence: [TOKEN_RING, TOKEN_RING_PRESS],
  },
  {
    key: "skipSubPhase :: AdvanceOperatingSubPhase",
    verdict: "latched",
    why:
      "The bar's Skip (sessionReady). The `automatic` entry (`skipSubPhaseAutomatically`, the auto-skip) is `derived`: the " +
      "game's own action, never sent on the server path, no latch taken and, since P3-N021, none released (RED R4 effect).",
    evidence: [BAR, { file: "shell", within: ["const skipSubPhase = useCallback(", "if (!sandbox) return;"], text: "{ automatic, derived: automatic, skipReason: reason ?? null }" }],
  },
  {
    key: "endTurnAutomatically :: PassTurn",
    verdict: "exempt",
    why:
      "`derived` (the auto-skip's end of turn, #876): the game moving on the player's behalf, not a press -- never sent on " +
      "the server path (the server derives it, #1203/#1213), takes no latch, and since P3-N021 cannot release a held one. " +
      "Its effect is RED R4, outside this slice's OD-12 grant.",
    evidence: [{ file: "shell", text: 'runGameplayAction("PassTurn", { PassTurn: { game_id: gameId } }, { automatic: true, derived: true })' }],
  },
  {
    key: "handleMakeTrainOffer :: BuyTrainFromCorporation",
    verdict: "latched",
    why:
      "Reached only through `handleProposeTrainTrade` (one president over both corporations): the Buy Trains offer form " +
      "(sessionReady through canTrade, + W3-I link queue) and the emergency modal's Step 1 (W2-G latch).",
    evidence: [
      { file: "shell", within: ["const handleProposeTrainTrade = useCallback(", "runGameplayAction(\n        `Offered"], text: "handleMakeTrainOffer({" },
      { file: "components/TrainPurchasePanel.tsx", text: "const canTrade = canAct && sessionReady && blockedReason === null;" },
      EMERGENCY,
      EMERGENCY_LATCH,
    ],
  },
  {
    key: "handleProposeTrainTrade :: ProposeTrainPurchase",
    verdict: "latched",
    why: "The same two doors: the Buy Trains offer form and the emergency modal's Step 1.",
    evidence: [{ file: "panels/ContextualActionBar.tsx", within: ["<TrainPurchasePanel", "/>"], text: "sessionReady={sessionReady}" }, EMERGENCY, EMERGENCY_LATCH],
  },
  {
    key: "handleAnswerFundingPrivateOffer :: AnswerFundingPrivateOffer",
    verdict: "latched",
    why: "FundingPrivateOfferPrompt (actionInFlight) and the emergency modal's own answer (W2-G latch).",
    evidence: [{ file: "shell", within: ["<FundingPrivateOfferPrompt", "/>"], text: "actionInFlight={actionInFlight}" }, EMERGENCY, EMERGENCY_LATCH],
  },
  {
    key: "handleDiscardTrain :: DiscardTrain",
    verdict: "latched",
    why: "TrainDiscardPrompt's discard (`offTurn`), greyed on actionInFlight.",
    evidence: [{ file: "shell", within: ["<TrainDiscardPrompt", "/>"], text: "actionInFlight={actionInFlight}" }],
  },
  ...([
    ["handleAcceptSandboxTrainOffer", "AnswerTrainPurchase"],
    ["handleRejectSandboxTrainOffer", "AnswerTrainPurchase"],
    ["handleRescindSandboxTrainOffer", "RescindTrainPurchase"],
  ] as const).map(
    ([name, msg]): CallSiteEntry => ({
      key: `${name} :: ${msg}`,
      verdict: "latched",
      why: "TrainTradePrompt (actionInFlight; W1-D / AUD-25.01).",
      evidence: [{ file: "shell", within: ["<TrainTradePrompt", "/>"], text: "actionInFlight={actionInFlight}" }],
    }),
  ),
  {
    key: "<shell effect> :: owed.msg",
    verdict: "exempt",
    why:
      "The no-server path's derived purchase (#1247 / W3-K): `automatic` + `derived`, decided by `noServerDerivedToSend` " +
      "once per key; never sent on the server path, takes no latch, and since P3-N021 releases none. RED R4 region.",
    evidence: [{ file: "shell", text: "const owed = noServerDerivedToSend({" }],
  },
  {
    key: "answer < handleSandboxLayTile :: LayTile",
    verdict: "latched",
    why: "Reached only from `handleConfirmRadialLay` -- the tile ring's tick (W1-E: latched at the mount and in its view).",
    evidence: [{ file: "shell", text: "layAnswer = handleSandboxLayTile(" }, TILE_RING, TILE_RING_PRESS],
  },
  {
    key: "drain :: msg",
    verdict: "exempt",
    why: "The drain applying a LANDED entry (`isRemoteReplay`): it never reaches the submit half, so it sends nothing.",
    evidence: [{ file: "shell", text: "if (roomCode && options?.isRemoteReplay !== true) {" }],
  },
  { key: "handleConfirmRadialLay :: LayTile", verdict: "latched", why: "The tile ring's tick (W1-E: latched in its view and at the mount).", evidence: [TILE_RING, TILE_RING_PRESS] },
  ...([
    ["@onRescindTrade", "RescindTrainPurchase"],
    ["@onForgoTrainTrade", "ForgoTrainTrade"],
    ["@onSellPortfolio", "EmergencySellPortfolio"],
    ["@onOfferPrivate", "OfferPrivateForFunding"],
    ["@onRescindPrivateOffer", "RescindFundingPrivateOffer"],
    ["@onForgoPrivateFunding", "ForgoPrivateFunding"],
  ] as const).map(
    ([prop, msg]): CallSiteEntry => ({
      key: `${prop} :: ${msg}`,
      verdict: "latched",
      why: "The W2-G emergency modal: every control that sends is greyed while `pressed || actionInFlight`.",
      evidence: [EMERGENCY, EMERGENCY_LATCH],
    }),
  ),
];

/* The enumerator: every call of `runGameplayAction(...)` or `runGameplayActionRef.current?.(...)`, by AST. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require("typescript") as typeof import("typescript");

interface CallSite {
  file: string;
  line: number;
  key: string;
}
function calleeName(expression: import("typescript").Expression): string | null {
  // W3-B review: `runGameplayActionRef.current!(...)` and `(runGameplayAction)(...)` are the same call.
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)) return calleeName(expression.expression);
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = calleeName(expression.expression);
    return left === null ? null : `${left}.${expression.name.text}`;
  }
  return null;
}
function enumerateCallSites(file: string, source: string): CallSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: CallSite[] = [];
  const visit = (node: import("typescript").Node) => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee === "runGameplayAction" || callee === "runGameplayActionRef.current") {
        const chain: string[] = [];
        for (let at = node.parent; at; at = at.parent) {
          if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) chain.push(at.name.text);
          else if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name)) chain.push(at.name.text);
          else if (ts.isJsxAttribute(at)) chain.push(`@${at.name.getText(sf)}`);
          else if (ts.isFunctionDeclaration(at) && at.name) chain.push(at.name.text);
        }
        // The component itself is not a binding worth naming; its body is "<shell effect>".
        const named = chain.filter((name) => name !== "AppShell").slice(0, 2);
        const msgArg = node.arguments[1];
        const msg =
          msgArg === undefined
            ? "?"
            : ts.isObjectLiteralExpression(msgArg)
              ? msgArg.properties.map((property) => (property.name ? property.name.getText(sf) : "...")).join(",")
              : ts.isCallExpression(msgArg)
                ? (calleeName(msgArg.expression) ?? msgArg.expression.getText(sf))
                : msgArg.getText(sf);
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          key: `${named.length > 0 ? named.join(" < ") : "<shell effect>"} :: ${msg}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}
/** The shell's files (the composition root and `shell/**`), relative to `src/`, as every shell read takes them. */
const shellFiles = () => shellSourcePaths();
function readEvidenceSource(file: string): string {
  return file === "shell" ? readShell() : readStripped(file);
}

describe("AUD-14.06: every `runGameplayAction` call site is latched or exempt with a precise reason", () => {
  const sites = shellFiles().flatMap((file) => enumerateCallSites(file, readSource(file)));

  it("the enumerator found the shell's dispatch sites (a vacuous scan cannot pass)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(50);
  });

  it("no call site is uncategorised, and no registry entry is stale", () => {
    const found = new Map<string, number[]>();
    for (const site of sites) found.set(site.key, [...(found.get(site.key) ?? []), site.line]);
    const registered = new Map(REGISTRY.map((entry) => [entry.key, entry]));
    const uncategorised = Array.from(found.keys()).filter((key) => !registered.has(key));
    expect(uncategorised).toEqual([]);
    const stale = REGISTRY.filter((entry) => !found.has(entry.key)).map((entry) => entry.key);
    expect(stale).toEqual([]);
    const wrongCount = REGISTRY.filter((entry) => (found.get(entry.key)?.length ?? 0) !== (entry.count ?? 1)).map(
      (entry) => `${entry.key}: registry ${entry.count ?? 1}, source ${found.get(entry.key)?.length ?? 0}`,
    );
    expect(wrongCount).toEqual([]);
    expect(new Set(REGISTRY.map((entry) => entry.key)).size).toBe(REGISTRY.length);
  });

  it("every classification carries its reason, and every latched one its evidence", () => {
    for (const entry of REGISTRY) {
      expect(entry.why.length).toBeGreaterThan(30);
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });

  it("every piece of evidence is true of the source (comment-stripped)", () => {
    const missing: string[] = [];
    for (const entry of REGISTRY) {
      for (const fact of entry.evidence) {
        const source = readEvidenceSource(fact.file);
        const scope = fact.within ? sliceBetween(source, fact.within[0], fact.within[1]) : source;
        if (!scope.includes(fact.text)) missing.push(`${entry.key}: ${fact.file} lacks ${JSON.stringify(fact.text)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("nothing outside the shell calls the dispatch, and the shell has exactly one way to send", () => {
    const shellSet = new Set(shellFiles());
    const everySource = discoverSources(".");
    expect(everySource.length).toBeGreaterThan(100);
    const outside = everySource
      .filter((file) => !shellSet.has(file))
      .flatMap((file) => {
        const source = readSource(file);
        return source.includes("runGameplayAction") ? enumerateCallSites(file, source) : [];
      });
    expect(outside).toEqual([]);
    const shell = readShell();
    expect(shell.split(".submit(").length - 1).toBe(1);
    expect(shell.split("appendSandboxAction(").length - 1).toBe(1);
    const dispatch = sliceBetween(shell, "const runGameplayAction = useCallback(", "if (isRevertToMsg(msg)) {");
    expect(dispatch).toContain("? await link.submit(msg)");
    expect(dispatch).toContain(": await appendSandboxAction(");
  });

  it("the doors the registry rests on are the only ones: the licence chip and the dashboard's Proceed send nothing", () => {
    const dashboard = readStripped("components/WaterfallAuctionDashboard.tsx");
    expect(dashboard).not.toMatch(/onProceedToStockRound\(|onClick=\{onProceedToStockRound\}/);
    const shell = readShell();
    // `handleConfirmBoPar`, `handleProceedToStockRound` and `runPrivateExchange` each have one caller.
    expect(shell.split("onConfirmPar={handleConfirmBoPar}").length - 1).toBe(1);
    expect(shell.split("handleConfirmBoPar").length - 1).toBe(2); // the declaration and the prop
    expect(shell.split("runPrivateExchange(").length - 1).toBe(1);
    expect(shell.split("commitFreeStationPlacement(").length - 1).toBe(1);
    expect(shell.split("handleSandboxLayTile(").length - 1).toBe(1);
  });
});

/* W3-B review: THE DOORS ARE COUNTED TOO. The registry classifies call SITES; a new button wired to an already-latched
   handler would add a door without adding a site. Every handler (and wrapper) a latched entry rests on is pinned to its
   reference count in the comment-stripped shell -- declaration + the doors the registry names + dependency-array and
   wrapper uses -- so a new reference fails here until its door is checked and the count (and the entry's `why`) moved. */
const HANDLER_REFERENCES: Readonly<Record<string, number>> = {
  kanawhaLicenseControl: 5, closeRoom: 5, handleProceedToStockRound: 3, runPrivateExchange: 3, handlePassTurn: 6,
  handleUndoLastAction: 2, buyOneShare: 5, handleBuyShare: 2, commitFreeStationPlacement: 3, handleConfirmBoPar: 2,
  handleBuyDoubleCertificate: 2, handleSellShares: 2, handleRunTrains: 2, declareDividendsChoice: 7, handlePayDividends: 2,
  handleWithholdRevenue: 2, withholdRevenueAutomatically: 3, handleBuyTrainsFromBank: 2, handleExchangeForDiesel: 2,
  handleBuyReturnedTrain: 2, handleProposePrivatePurchase: 2, handleAcceptPrivateOffer: 2, handleRejectPrivateOffer: 2,
  handleRescindPrivateOffer: 2, handleProposePrivateTrade: 2, handleAnswerPrivateTrade: 3, handleRescindPrivateTrade: 3,
  handleWaterfallBuyLowest: 2, handleWaterfallBidHigher: 2, handleWaterfallPass: 2, handleWaterfallMiniAuctionRaise: 2,
  handleWaterfallMiniAuctionPass: 2, handleConfirmTokenPlacement: 2, skipSubPhase: 5, handleSkipSubPhase: 2,
  skipSubPhaseAutomatically: 3, endTurnAutomatically: 3, handleEndOperatingTurn: 2, handleMakeTrainOffer: 4,
  handleProposeTrainTrade: 3, handleAnswerFundingPrivateOffer: 3, handleDiscardTrain: 2, handleAcceptSandboxTrainOffer: 2,
  handleRejectSandboxTrainOffer: 2, handleRescindSandboxTrainOffer: 2, handleSandboxLayTile: 3, handleConfirmRadialLay: 2,
  handlePowerFlowAct: 2,
};

describe("AUD-14.06: the dispatch is only ever CALLED, and no door is added unseen", () => {
  it("`runGameplayAction` / `runGameplayActionRef.current` appear only as a callee, in a dependency list, or in their own wiring", () => {
    const strays: string[] = [];
    for (const file of shellFiles()) {
      const source = readSource(file);
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: import("typescript").Node) => {
        const isDispatch =
          (ts.isIdentifier(node) && node.text === "runGameplayAction") ||
          (ts.isPropertyAccessExpression(node) && calleeName(node) === "runGameplayActionRef.current");
        // W3-B re-review: `runGameplayAction.call(...)` / `.apply` / `.bind` are strays too -- no property access is excused.
        if (isDispatch) {
          let up: import("typescript").Node = node.parent;
          while (ts.isNonNullExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent;
          const asCallee = ts.isCallExpression(up) && calleeName(up.expression) !== null && up.expression.getStart(sf) === node.getStart(sf);
          const inDeps = ts.isArrayLiteralExpression(up);
          const ownDeclaration = ts.isVariableDeclaration(up) && up.name === node;
          const refWiring =
            ts.isBinaryExpression(up) &&
            up.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            up.getText(sf).replace(/\s+/g, " ") === "runGameplayActionRef.current = runGameplayAction";
          if (!asCallee && !inDeps && !ownDeclaration && !refWiring) {
            strays.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${up.getText(sf).slice(0, 80)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(strays).toEqual([]);
  });

  it("every handler a latched entry rests on has exactly the references its doors account for", () => {
    const shell = readShell();
    const drift = Object.entries(HANDLER_REFERENCES)
      .map(([name, expected]) => [name, expected, (shell.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length] as const)
      .filter(([, expected, found]) => expected !== found)
      .map(([name, expected, found]) => `${name}: pinned ${expected}, shell ${found}`);
    expect(drift).toEqual([]);
  });
});

/* ================================================================================================================ */
/*  P3-N021: THE AUTOMATIC PRESSES TAKE THE LATCH (RED R1)                                                             */
/* ================================================================================================================ */

describe("P3-N021: an `automatic` press is serialised with every other press", () => {
  function mountProbe(link: Room) {
    let api: ShellApi | null = null;
    act(() =>
      root.render(
        <Shell link={link}>
          {(shell) => {
            api = shell;
            return <span data-testid="busy">{String(shell.actionInFlight)}</span>;
          }}
        </Shell>,
      ),
    );
    return () => api as unknown as ShellApi;
  }
  const busy = () => byTestId("busy")?.textContent === "true";

  it("an automatic press latches at once, before the link answers -- on a connected link too", () => {
    const link = liveRoom();
    const shell = mountProbe(link);
    act(() => shell().press(EXCHANGE, { automatic: true }));
    expect(busy()).toBe(true);
    link.land("n1", 0);
    // The link has let go; the drain has not applied the entry: still latched (#1173's window).
    expect(link.client.queue.unsettled).toBe(0);
    expect(busy()).toBe(true);
    act(() => link.drain());
    expect(busy()).toBe(false);
  });

  it("a derived dispatch takes no latch -- and no longer RELEASES a player's held press", () => {
    const link = liveRoom();
    const shell = mountProbe(link);
    act(() => shell().press(SKIP));
    link.land("n1", 0); // the link has let go of the Skip; the drain has not applied it
    expect(busy()).toBe(true);
    // An auto-skip / forced withhold fires while the Skip is still held (an earlier entry drained and moved the step):
    // `derived`, not sent on the server path.
    act(() => shell().press(WITHHOLD, { automatic: true, derived: true }));
    expect(busy()).toBe(true); // before P3-N021 this set the latch to null: the controls re-armed on a stale board
    expect(link.kinds()).toEqual(["AdvanceOperatingSubPhase"]);
    act(() => link.drain());
    expect(busy()).toBe(false);
  });

  it("a derived dispatch on an idle shell leaves it idle", () => {
    const link = liveRoom();
    const shell = mountProbe(link);
    act(() => shell().press(WITHHOLD, { automatic: true, derived: true }));
    expect(busy()).toBe(false);
    expect(link.allSubmits()).toHaveLength(0);
  });

  it("network loss: a held automatic press keeps the latch past the backstop and is sent ONCE on reconnect", () => {
    const link = liveRoom(true);
    const shell = mountProbe(link);
    act(() => shell().press(SET_PAR, { automatic: true }));
    advance(LONG_PAST);
    expect(busy()).toBe(true);
    expect(link.client.queue.unsent).toBe(1);
    link.reconnect();
    expect(link.kinds()).toEqual(["SetBoPar"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(busy()).toBe(false);
  });

  it("a refused automatic press releases at once (the submit half's `null`), not on the clock", async () => {
    const link = liveRoom();
    const shell = mountProbe(link);
    act(() => shell().press(REVERT, { automatic: true }));
    link.refuse("n1");
    await flush();
    expect(busy()).toBe(false);
  });
});

/* ---- the surfaces ---------------------------------------------------------------------------------------------- */

describe("AUD-14.06 / P3-N021: the auction prompt (par confirm and Proceed)", () => {
  function mount(link: Room, par: boolean) {
    act(() =>
      root.render(
        <Shell link={link}>
          {(shell) => (
            <>
              <AuctionHarness shell={shell} par={par} />
              <button type="button" data-testid="sell" disabled={shell.actionInFlight} onClick={() => shell.press(SELL)}>
                sell
              </button>
            </>
          )}
        </Shell>,
      ),
    );
  }
  const proceed = () => must(byTestId("auction-proceed"), "Proceed");
  const parConfirm = () => buttonNamed(/^(Take the President|Sending)/);

  it("Proceed: a double click sends ONE OpenStockRound, held past the backstop while queued, re-armed by a refusal", async () => {
    const link = liveRoom(true);
    mount(link, false);
    expect(proceed().disabled).toBe(false);
    click(proceed());
    click(proceed());
    expect(proceed().disabled).toBe(true);
    expect(proceed().title).toBe(LINK_QUEUED_NOTE);
    advance(LONG_PAST);
    expect(proceed().disabled).toBe(true);
    click(proceed());
    link.reconnect();
    expect(link.kinds()).toEqual(["OpenStockRound"]);
    expect(proceed().title).toBe(LINK_SENDING_NOTE);
    link.refuse("n1");
    await flush();
    expect(proceed().disabled).toBe(false);
  });

  it("the par confirm cannot follow ANOTHER press still in flight (a sale held by the link)", () => {
    const link = liveRoom(true);
    mount(link, true);
    expect(parConfirm().disabled).toBe(false);
    click(byTestId("sell"));
    advance(LONG_PAST);
    expect(parConfirm().disabled).toBe(true);
    expect(parConfirm().title).toBe(LINK_QUEUED_NOTE);
    click(parConfirm());
    link.reconnect();
    expect(link.kinds()).toEqual(["SellStock"]);
    link.land("n1", 0);
    expect(parConfirm().disabled).toBe(true); // landed, not yet applied
    act(() => link.drain());
    expect(parConfirm().disabled).toBe(false);
  });

  it("the par press itself holds every other control past every clock, and lands once", () => {
    const link = liveRoom(true);
    mount(link, true);
    click(parConfirm());
    click(parConfirm());
    advance(LONG_PAST);
    expect(must(byTestId("sell"), "sell").disabled).toBe(true);
    link.reconnect();
    expect(link.kinds()).toEqual(["SetBoPar"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(must(byTestId("sell"), "sell").disabled).toBe(false);
  });
});

describe("AUD-14.06: BuyLicenseModal", () => {
  function mount(link: Room) {
    act(() => root.render(<Shell link={link}>{(shell) => <LicenseHarness shell={shell} />}</Shell>));
  }
  const buy = () => byTestId("buy-license-confirm");

  it("a held licence purchase greys the reopened modal's Buy past the backstop; one BuyKanawhaLicense; re-armed on refusal", async () => {
    const link = liveRoom(true);
    mount(link);
    expect(must(buy(), "Buy").disabled).toBe(false);
    click(buy());
    expect(buy()).toBeNull(); // the modal closes on the press
    advance(LONG_PAST);
    click(byTestId("open-licence")); // the L8 hex reopens it
    expect(must(buy(), "Buy").disabled).toBe(true);
    expect(must(buy(), "Buy").title).toBe(LINK_QUEUED_NOTE);
    click(buy());
    link.reconnect();
    expect(link.kinds()).toEqual(["BuyKanawhaLicense"]);
    link.refuse("n1");
    await flush();
    expect(must(buy(), "Buy").disabled).toBe(false);
  });

  it("same player's submission lands: the Buy stays greyed until the drain applies it", () => {
    const link = liveRoom();
    mount(link);
    click(buy());
    click(byTestId("open-licence"));
    link.land("n1", 0);
    expect(must(buy(), "Buy").disabled).toBe(true);
    expect(must(buy(), "Buy").title).toBe(LINK_SENDING_NOTE);
    act(() => link.drain());
    expect(must(buy(), "Buy").disabled).toBe(false);
  });

  it("another seat's move landing greys nothing", () => {
    const link = liveRoom();
    mount(link);
    link.otherSeat(0);
    act(() => link.drain());
    expect(must(buy(), "Buy").disabled).toBe(false);
  });
});

describe("AUD-14.06 / P3-N021: PrivatePowerFlowModal (the M&H exchange)", () => {
  function mount(link: Room) {
    act(() => root.render(<Shell link={link}>{(shell) => <PowerFlowHarness shell={shell} />}</Shell>));
  }
  const ipo = () => byTestId("power-flow-act-exchange-ipo");

  it("an exchange held by the link greys every act button of the reopened modal; one ExchangePrivate", () => {
    const link = liveRoom(true);
    mount(link);
    expect(must(ipo(), "IPO act").disabled).toBe(false);
    click(ipo());
    advance(LONG_PAST);
    click(byTestId("open-flow"));
    expect(must(ipo(), "IPO act").disabled).toBe(true);
    expect(must(byTestId("power-flow-act-exchange-bank"), "Bank act").disabled).toBe(true);
    expect(must(ipo(), "IPO act").title).toBe(LINK_QUEUED_NOTE);
    click(ipo());
    link.reconnect();
    expect(link.kinds()).toEqual(["ExchangePrivate"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(must(ipo(), "IPO act").disabled).toBe(false);
  });

  it("the decline sends nothing and stays available", () => {
    const link = liveRoom(true);
    mount(link);
    click(ipo());
    click(byTestId("open-flow"));
    const decline = buttonNamed(/^No, Keep the Private/);
    expect(decline.disabled).toBe(false);
    click(decline);
    expect(link.client.queue.unsettled).toBe(1); // only the exchange, still queued for the socket
    link.reconnect();
    expect(link.kinds()).toEqual(["ExchangePrivate"]);
  });
});

describe("AUD-14.06 / P3-N021: the token confirm (a paid token and a free home station)", () => {
  function mount(link: Room, free: boolean) {
    act(() =>
      root.render(
        <Shell link={link}>
          {(shell) => (
            <>
              <TokenHarness shell={shell} free={free} />
              <button type="button" data-testid="sell" disabled={shell.actionInFlight} onClick={() => shell.press(SELL)}>
                sell
              </button>
            </>
          )}
        </Shell>,
      ),
    );
  }

  it("a paid token: one PlaceStationToken; a re-staged token cannot confirm while the first is held", () => {
    const link = liveRoom(true);
    mount(link, false);
    expect(tokenTick().disabled).toBe(false);
    click(tokenTick());
    advance(LONG_PAST);
    click(byTestId("stage-token"));
    expect(tokenTick().disabled).toBe(true);
    expect(tokenTick().title).toBe(LINK_QUEUED_NOTE);
    click(tokenTick());
    link.reconnect();
    expect(link.kinds()).toEqual(["PlaceStationToken"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(tokenTick().disabled).toBe(false);
  });

  it("a free home station (`automatic`) latches like any press -- and a token cannot follow another held press", () => {
    const link = liveRoom(true);
    mount(link, true);
    click(byTestId("sell"));
    advance(LONG_PAST);
    expect(tokenTick().disabled).toBe(true);
    click(tokenTick());
    link.reconnect();
    link.land("n1", 0);
    act(() => link.drain());
    expect(tokenTick().disabled).toBe(false);
    click(tokenTick());
    expect(must(byTestId("sell"), "sell").disabled).toBe(true); // the home station holds the board
    expect(link.kinds()).toEqual(["SellStock", "PlaceHomeStation"]);
  });
});

describe("AUD-14.06: route edits and the Run they feed", () => {
  function mount(link: Room) {
    act(() =>
      root.render(
        <Shell link={link}>
          {(shell) => <ContextualActionBar {...barProps(shell, "OperatingRound", "Routes", { trainDrafts: [DRAFT] })} />}
        </Shell>,
      ),
    );
  }
  const run = () => buttonNamed(/^Run Trains/);

  it("Run: one RunMultipleRoutes; the route chip's edit controls are withdrawn while it is held", () => {
    const link = liveRoom(true);
    mount(link);
    click(buttonNamed(/^3/)); // open the 3-train's route readout
    expect(buttonNamed(/^Clear$/).disabled).toBe(false);
    expect(run().disabled).toBe(false);
    click(run());
    click(run());
    advance(LONG_PAST);
    expect(run().disabled).toBe(true);
    expect(allButtons().some((node) => text(node) === "Clear")).toBe(false); // `canClear` is false: no edit offered
    link.reconnect();
    expect(link.kinds()).toEqual(["RunMultipleRoutes"]);
    link.land("n1", 0);
    act(() => link.drain());
    expect(run().disabled).toBe(false);
    expect(buttonNamed(/^Clear$/).disabled).toBe(false);
  });
});

describe("AUD-14.06 / P3-N021: Undo", () => {
  function mount(link: Room) {
    act(() => root.render(<Shell link={link}>{(shell) => <ContextualActionBar {...barProps(shell, "StockRound", "Track")} />}</Shell>));
  }
  const undo = () => buttonNamed(/^Undo Last Action/);

  it("a double click sends ONE RevertTo; held past the backstop; released when it lands and is applied", () => {
    const link = liveRoom(true);
    mount(link);
    expect(undo().disabled).toBe(false);
    click(undo());
    click(undo());
    advance(LONG_PAST);
    expect(undo().disabled).toBe(true);
    expect(undo().title).toBe(LINK_QUEUED_NOTE);
    click(undo());
    link.reconnect();
    expect(link.kinds()).toEqual(["RevertTo"]);
    link.land("n1", 0);
    expect(undo().disabled).toBe(true);
    act(() => link.drain());
    expect(undo().disabled).toBe(false);
  });

  it("another seat's move landing MID-HOLD keeps Undo busy while the link still holds the press", () => {
    const link = liveRoom();
    mount(link);
    click(undo());
    act(() => link.wire().deliver({ kind: "refused", build: "build-1", code: "unavailable", reason: "Could not confirm.", inReplyTo: "n1" }));
    link.otherSeat(0);
    act(() => link.drain());
    expect(link.client.queue.unsettled).toBe(1);
    expect(undo().disabled).toBe(true);
    advance(LONG_PAST);
    expect(undo().disabled).toBe(true);
    click(undo());
    expect(link.kinds()).toEqual(["RevertTo"]);
  });
});

describe("P3-N021 through the surfaces: an automatic press holds them in the window between LANDING and the DRAIN", () => {
  /* W3-B review: with the link down, the link's own hold keeps every control busy whether or not the press latched. The
     window that only the latch covers is after the link lets go (`applied`) and before the drain applies the entry --
     #1173's one round trip. Before P3-N021 an `automatic` press took no latch, so each surface below re-armed in it. */
  const probe = (shell: ShellApi) => (
    <button type="button" data-testid="probe" disabled={shell.actionInFlight} onClick={noop}>
      probe
    </button>
  );
  type Case = [string, (shell: ShellApi) => React.ReactNode, () => void, () => void, () => boolean, string];
  const cases: Case[] = [
    ["Proceed (OpenStockRound)", (shell) => <AuctionHarness shell={shell} par={false} />, () => click(byTestId("auction-proceed")), noop,
      () => must(byTestId("auction-proceed"), "Proceed").disabled, "OpenStockRound"],
    ["the M&H exchange (ExchangePrivate)", (shell) => <PowerFlowHarness shell={shell} />, () => click(byTestId("power-flow-act-exchange-ipo")),
      () => click(byTestId("open-flow")), () => must(byTestId("power-flow-act-exchange-ipo"), "IPO act").disabled, "ExchangePrivate"],
    ["a free home station (PlaceHomeStation)", (shell) => <TokenHarness shell={shell} free />, () => click(tokenTick()),
      () => click(byTestId("stage-token")), () => tokenTick().disabled, "PlaceHomeStation"],
    ["the B&O par (SetBoPar)",
      (shell) => <button type="button" data-testid="par" onClick={() => shell.press(SET_PAR, { automatic: true })}>par</button>,
      () => click(byTestId("par")), noop, () => must(byTestId("probe"), "probe").disabled, "SetBoPar"],
    ["Undo (RevertTo)", (shell) => <ContextualActionBar {...barProps(shell, "StockRound", "Track")} />,
      () => click(buttonNamed(/^Undo Last Action/)), noop, () => buttonNamed(/^Undo Last Action/).disabled, "RevertTo"],
  ];

  it.each(cases)("%s: its surface and every other control stay greyed until the drain applies it", (_name, surface, press, reopen, greyed, kind) => {
    const link = liveRoom();
    act(() =>
      root.render(
        <Shell link={link}>
          {(shell) => (
            <>
              {surface(shell)}
              {probe(shell)}
            </>
          )}
        </Shell>,
      ),
    );
    expect(greyed()).toBe(false);
    press();
    reopen(); // what the press closed (the modal, the ring), as a player would
    link.land("n1", 0);
    expect(link.client.queue.unsettled).toBe(0); // the link has let go: only the latch covers this window
    expect(link.kinds()).toEqual([kind]);
    expect(greyed()).toBe(true);
    expect(must(byTestId("probe"), "probe").disabled).toBe(true);
    act(() => link.drain());
    expect(greyed()).toBe(false);
    expect(must(byTestId("probe"), "probe").disabled).toBe(false);
  });
});

/* ================================================================================================================ */
/*  SOURCE PINS: the stand-in above is the shell's, and the surfaces are wired to the one flag                        */
/* ================================================================================================================ */

describe("the shell's wiring (source pins)", () => {
  const APP = readShell();
  const dispatch = sliceBetween(APP, "const runGameplayAction = useCallback(", "if (isRevertToMsg(msg)) {");

  it("RED R1 (P3-N021): every press but a derived one takes the latch, and the derived return releases nothing", () => {
    expect(dispatch).toContain("if (options?.derived !== true) setPendingAppendIndex(appendAt);");
    expect(dispatch).not.toContain("options?.automatic !== true) setPendingAppendIndex");
    const derivedReturn = sliceBetween(dispatch, "if (link && options?.derived === true) {", "}");
    expect(derivedReturn).not.toContain("setPendingAppendIndex");
    expect(derivedReturn).toContain("return;");
    // The release lines are unchanged (RED R1's null, RED R5's index release).
    expect(dispatch.split("setPendingAppendIndex((current) => (current === appendAt ? null : current));").length - 1).toBe(2);
    expect(APP).toContain("current !== null && appliedIndexRef.current > current ? null : current,");
  });

  it("the catching-up gate, the board-currency gate and the turn gate still come BEFORE the latch (W3-J preserved)", () => {
    expectOrder(
      dispatch,
      "replayingRef.current",
      "setSandboxRoomError(CATCHING_UP_BANNER);",
      "const notLive = boardSendRefusalRef.current();",
      "setSandboxRoomError(TURN_REFUSAL);",
      "if (options?.derived !== true) setPendingAppendIndex(appendAt);",
      "if (link && options?.derived === true) {",
      "? await link.submit(msg)",
    );
    // A player decision sent `automatic` is refused while catching up; only the replay and the derived actions pass.
    expect(sliceBetween(dispatch, "if (\n          options?.isRemoteReplay !== true &&\n          options?.derived !== true &&", "return false;")).toContain(
      "replayingRef.current",
    );
  });

  it("the one sentence is derived once from the one flag and W3-I's view", () => {
    expect(APP).toContain("const actionInFlightReason = actionLatchReason(actionInFlight, linkQueueNote);");
    expect(APP.split("actionLatchReason(").length - 1).toBe(1);
    expectOrder(APP, "const actionInFlight = useActionLatch(", "const actionInFlightReason = actionLatchReason(");
  });

  it("the standing instructions wait for the press in flight", () => {
    expect(sliceBetween(APP, "if (autoPassArm.player !== viewerAddress) return;", "void handlePassTurn();")).toContain(
      "if (actionInFlight) return;",
    );
    expect(sliceBetween(APP, "if (autoBuyPlan.player !== viewerAddress) return;", "const sent = buyOneShare(")).toContain(
      "if (actionInFlight) return;",
    );
    expect(APP).toContain("}, [autoPassArm, gameState, viewerAddress, isMyTurn, handlePassTurn, logInfo, sandboxMarketPrices, actionInFlight]);");
    expect(sliceBetween(APP, "const sent = buyOneShare(", "const handleSellShares")).toContain("homeHexToAxial,\n    actionInFlight,\n  ]);");
  });

  it("the map's route clicks are consumed while a press is in flight", () => {
    expect(sliceBetween(APP, "onHexClick={", "onHexClickQuery=")).toMatch(
      /routeSelectMode\s*\?\s*actionInFlight\s*\?\s*ROUTE_EDIT_WHILE_IN_FLIGHT\s*:\s*handleRouteHexClick/,
    );
  });

  it("the helper reads; it never sends, queues or times", () => {
    const LATCH = readStripped("utils/actionLatch.ts");
    expect(LATCH).toContain("if (!actionInFlight) return null;");
    expect(LATCH).toContain("return link.blocked && link.reason !== null ? link.reason : LINK_SENDING_NOTE;");
    expect(LATCH).not.toMatch(/\bsubmit\(|connectServerLink|getActiveLinkQueue/);
    expect(LATCH.split("setTimeout(").length - 1).toBe(1); // W3-B's one backstop, nothing new
  });
});

describe("actionLatchReason (pure)", () => {
  const idle: LinkQueueView = { blocked: false, queued: false, reason: null };
  it("is null when nothing is in flight, whatever the link says", () => {
    expect(actionLatchReason(false, idle)).toBeNull();
    expect(actionLatchReason(false, { blocked: true, queued: true, reason: LINK_QUEUED_NOTE })).toBeNull();
  });
  it("puts the link's own sentence first, then the latch's", () => {
    expect(actionLatchReason(true, { blocked: true, queued: true, reason: LINK_QUEUED_NOTE })).toBe(LINK_QUEUED_NOTE);
    expect(actionLatchReason(true, idle)).toBe(LINK_SENDING_NOTE);
  });
});
