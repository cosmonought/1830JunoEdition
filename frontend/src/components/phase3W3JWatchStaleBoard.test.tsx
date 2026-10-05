/** @jest-environment jsdom */
//
// ==================================================================
//  PHASE 3 W3-J (AUD-25.16 / U-56, HIGH; OD-19 RULED): WATCH IS READ-ONLY, AND A BOARD THAT IS NOT THE ROOM'S
//  CANNOT SEND A MOVE
// ==================================================================
//
// OD-19: (1) Watch always opens a READ-ONLY spectator view, even for a principal seated at the table; a seat is
// re-entered through "Your tables" / Open / Rejoin. (2) While replay, catch-up or divergence is unresolved, gameplay
// controls are non-actionable. (3) The submission is bound to the log position actually APPLIED to the board, and the
// server rejects one whose applied position is not the authoritative pre-action position.
//
// Exercised here with the real pieces: the Lobby's two doors, the active-game pointer, the watcher projection, the
// board-currency answers, the forced notice, the REAL `connectServerLink` over an injected socket, and the REAL
// `RoomSession` (the server's room engine) answering what the link sends. The shell's wiring is source-pinned where it
// cannot be executed (the "shell wiring" block below, `phase3W3JRed.test.ts` and `phase3W3GWatchDefect.test.tsx`).

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LobbyRoomList } from "./LobbyRoomList";
import { MyTablesList } from "./MyTablesList";
import { BoardBehindNotice } from "./BoardBehindNotice";
import { ModalLayerHost } from "./ModalPortal";
import { STANDARD_VARIANTS } from "../gameEngine/gameVariants";
import type { MyTableSummary, RoomSummary, RoomView } from "../utils/roomProtocol";
import { ACTIVE_GAME_STORAGE_KEY, readActiveGame } from "../utils/activeGame";
import { watcherRoomView } from "../utils/watchView";
import {
  BOARD_CURRENT,
  BOARD_DIVERGED_NOTICE,
  BOARD_DRAIN_FAILED_NOTICE,
  WATCHING_NO_SEAT,
  appliedPositionFor,
  boardCurrencyFor,
  boardSendRefusal,
} from "../utils/boardCurrency";
import { CATCHING_UP_BANNER } from "../utils/roomNotices";

const { connectServerLink } = require("../utils/serverLink") as typeof import("../utils/serverLink");
type SocketLike = import("../utils/serverLink").SocketLike;
const { RoomSession } = require("../utils/roomSession") as typeof import("../utils/roomSession");
const { sandboxReplayProviders } = require("../gameEngine/replayProviders") as typeof import("../gameEngine/replayProviders");
const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } =
  require("../gameEngine/sandboxState") as typeof import("../gameEngine/sandboxState");
const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup") as typeof import("../gameEngine/gameSetup");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GAME = "g_0123456789abcdefghjkmnpqr0";
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
  window.sessionStorage.clear();
});
const render = (node: React.ReactElement) => act(() => root.render(node));

/* ------------------------------------------------------------------ OD-19 (1): READ-ONLY WATCH */

describe("W3-J AUD-25.16 (A, OD-19): Watch is its own, read-only door", () => {
  const publicRow: RoomSummary = {
    gameId: GAME,
    code: "JUNO-1A1",
    status: "playing",
    hostNickname: "Owner",
    nicknames: ["Owner", "Bea"],
    readyCount: 0,
    seated: 2,
    seatCap: 2,
    playerCount: 2,
    variants: STANDARD_VARIANTS,
    createdAtMs: 0,
  };
  const myTable: MyTableSummary = {
    gameId: GAME,
    state: "playing",
    visibility: "public",
    hostNickname: "Owner",
    nicknames: ["Owner", "Bea"],
    you: "host",
    createdAtMs: 1,
    lastActivityMs: 2,
  };

  it("the Watch control keeps its wording (OD-19 item 5)", () => {
    render(<LobbyRoomList rooms={[publicRow]} loading={false} error={null} available busy={false} refusal={null} onJoin={() => {}} onWatch={() => {}} />);
    expect((host.querySelector('[data-testid="lobby-watch-JUNO-1A1"]') as HTMLButtonElement).title).toBe("Watch this game. You will not have a seat.");
  });

  it("'Your tables' (the seat path) and Watch reach the shell through different doors", () => {
    const { readStripped } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("onOpen={(gameId) => onEnterSandbox(gameId)}");
    expect(lobby).toContain("onWatch={(gameId) => (onWatchSandbox ?? onEnterSandbox)(gameId)}");
    // ... and the seat path is unchanged: Open still hands the bare game id to the seat door.
    const opened: string[] = [];
    render(<MyTablesList tables={[myTable]} error={null} onOpen={(id) => opened.push(id)} />);
    act(() => (host.querySelector('[data-testid="my-table-row"] button') as HTMLButtonElement).click());
    expect(opened).toEqual([GAME]);
  });

  it("the watch intent survives a reload; the seat path's pointer carries none (design note #24)", () => {
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox", watch: true }));
    expect(readActiveGame()).toEqual({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox", watch: true });
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
    expect(readActiveGame()).toEqual({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" });
    // Anything but `true` is no watch (a pointer cannot be talked into one by a stray value).
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox", watch: "yes" }));
    expect(readActiveGame()).toEqual({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" });
  });

  it("a Watch tab reads the server's view of a SEATED principal (even the host) as a watcher's -- the room's facts unchanged", () => {
    const seatedHost = {
      gameId: GAME,
      code: "JUNO-1A1",
      joinable: false,
      visibility: "public",
      status: "playing",
      lifecycle: "active",
      closed: false,
      held: false,
      holdKind: null,
      hostId: "p-owner",
      players: [{ id: "p-owner", nickname: "Owner", isReady: true, online: true }],
      playerCount: 2,
      seatCap: 2,
      variants: STANDARD_VARIANTS,
      createdAtMs: 0,
      undoPolicy: { host_undo: "own-only" },
      you: { role: "host", playerId: "p-owner", kicked: false, canStart: true },
      money: { you: { wallet: "juno1..." } },
    } as unknown as RoomView;
    const watched = watcherRoomView(seatedHost)!;
    expect(watched.you).toEqual({ role: "viewer", playerId: null, kicked: false, canStart: false });
    expect((watched.money as unknown as { you: unknown }).you).toBeNull();
    expect({ ...watched, you: seatedHost.you, money: seatedHost.money }).toEqual(seatedHost);
    expect(watcherRoomView(null)).toBeNull();
  });

  it("a Watch tab sends no gameplay move: the send gate and the link both refuse it", () => {
    const current = boardCurrencyFor({ drainFailed: false, divergedAt: null });
    expect(boardSendRefusal({ watchOnly: true, currency: current })).toBe(WATCHING_NO_SEAT);
    expect(appliedPositionFor({ watchOnly: true, currency: current, replaying: false, log: [], catchingUpNotice: CATCHING_UP_BANNER })).toEqual({ notCurrent: WATCHING_NO_SEAT });
    expect(boardSendRefusal({ watchOnly: false, currency: current })).toBeNull();
  });
});

/* ------------------------------------------------------------------ OD-19 (2): NON-ACTIONABLE WHILE NOT CURRENT */

describe("W3-J AUD-25.16 (B): the board's currency", () => {
  it("a failed drain pass and an unresolved divergence (agreed before or never) each make the board not current", () => {
    expect(boardCurrencyFor({ drainFailed: false, divergedAt: null })).toEqual({ current: true });
    expect(boardCurrencyFor({ drainFailed: true, divergedAt: null })).toEqual({ current: false, reason: "drain-failed", notice: BOARD_DRAIN_FAILED_NOTICE });
    expect(boardCurrencyFor({ drainFailed: false, divergedAt: 41 })).toEqual({ current: false, reason: "diverged", notice: BOARD_DIVERGED_NOTICE });
    // A failed drain outranks a divergence: the board is incomplete, not merely different.
    expect(boardCurrencyFor({ drainFailed: true, divergedAt: 41 })).toMatchObject({ reason: "drain-failed" });
  });

  it("the position a submission is bound to: the last entry the completed pass applied, or none", () => {
    const log = [
      { index: 0, id: "e0" },
      { index: 1, id: "e1" },
    ];
    const current = boardCurrencyFor({ drainFailed: false, divergedAt: null });
    expect(appliedPositionFor({ watchOnly: false, currency: current, replaying: false, log, catchingUpNotice: CATCHING_UP_BANNER })).toEqual({ index: 1, id: "e1" });
    expect(appliedPositionFor({ watchOnly: false, currency: current, replaying: false, log: [], catchingUpNotice: CATCHING_UP_BANNER })).toEqual({ index: -1, id: undefined });
    expect(appliedPositionFor({ watchOnly: false, currency: current, replaying: true, log, catchingUpNotice: CATCHING_UP_BANNER })).toEqual({ notCurrent: CATCHING_UP_BANNER });
    const failed = boardCurrencyFor({ drainFailed: true, divergedAt: null });
    expect(appliedPositionFor({ watchOnly: false, currency: failed, replaying: false, log, catchingUpNotice: CATCHING_UP_BANNER })).toEqual({ notCurrent: BOARD_DRAIN_FAILED_NOTICE });
  });

  it("the forced notice: a native modal with the reason and Reload / Back to the lobby; nothing when current", () => {
    const calls: string[] = [];
    render(
      <>
        <BoardBehindNotice notice={null} onReload={() => calls.push("reload")} onLeave={() => calls.push("leave")} />
        <ModalLayerHost />
      </>,
    );
    expect(document.querySelector('[data-testid="board-behind-notice"]')).toBeNull();
    render(
      <>
        <BoardBehindNotice notice={BOARD_DRAIN_FAILED_NOTICE} onReload={() => calls.push("reload")} onLeave={() => calls.push("leave")} />
        <ModalLayerHost />
      </>,
    );
    const dialog = document.querySelector('[data-testid="board-behind-notice"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.getAttribute("closedby")).toBe("none"); // no Escape, no scrim: the remedy is a reload
    expect(dialog.textContent).toContain(BOARD_DRAIN_FAILED_NOTICE);
    act(() => (document.querySelector('[data-testid="board-behind-reload"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid="board-behind-lobby"]') as HTMLButtonElement).click());
    expect(calls).toEqual(["reload", "leave"]);
  });
});

/* ------------------------------------------------------------------ OD-19 (3): THE SUBMISSION IS BOUND TO THE APPLIED POSITION */

const BUILD = "build-under-test";
const SETUP = {
  SetupGame: {
    players: [
      { id: "p-owner", nickname: "Owner" },
      { id: "p-bea", nickname: "Bea" },
    ],
    variants: {},
  },
} as never;
const BUY_LOWEST = { WaterfallBuyLowest: { game_id: 0 } } as never;

function room() {
  let n = 0;
  const session = new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
  });
  return session;
}

describe("W3-J AUD-25.16 (C): a move chosen on a board resting behind the room is bound to that board, and does not land", () => {
  it("end to end: the link stamps the board's APPLIED position, and the room answers it as stale -- not applied", async () => {
    // The room: deal, the owner's purchase, Bea's purchase -- the owner is on turn again at index 2.
    const session = room();
    session.submit({ actor: "p-owner", build: BUILD, msg: SETUP, baseIndex: -1 });
    const [owner, bea] = session.state.player_addresses;
    session.submit({ actor: owner, build: BUILD, msg: BUY_LOWEST, baseIndex: 0 });
    session.submit({ actor: bea, build: BUILD, msg: BUY_LOWEST, baseIndex: 1 });
    expect(session.nextIndex - 1).toBe(2);

    // The tab: its link received all three entries, but its board APPLIED only index 0 (a drain that stopped there).
    const wire: Array<Record<string, unknown>> = [];
    const socket: SocketLike = { send: (data) => wire.push(JSON.parse(data)), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    const delivered = session.entries.map((entry) => ({ ...entry }));
    let applied = [delivered[0]];
    let stale = 0;
    let ids = 0;
    const link = connectServerLink({
      url: "ws://test",
      gameId: GAME,
      build: BUILD,
      socketFactory: () => socket,
      mintSubmissionId: () => `n${(ids += 1)}`,
      onEntries: () => {},
      onStale: () => (stale += 1),
      // W3-J review (LOW-4): the shell's own derivation over the drain's applied log, not a hand-written position.
      appliedPosition: () =>
        appliedPositionFor({ watchOnly: false, currency: BOARD_CURRENT, replaying: false, log: applied, catchingUpNotice: CATCHING_UP_BANNER }),
    });
    socket.onopen?.({});
    socket.onmessage?.({ data: JSON.stringify({ kind: "catch-up", build: BUILD, digest: null, entries: delivered }) });
    expect(link.appliedIndex).toBe(2); // the link has DELIVERED through 2 ...
    const move = link.submit(BUY_LOWEST);
    const submit = wire.find((frame) => frame.kind === "submit")!;
    expect(submit).toMatchObject({ baseIndex: 0, baseId: delivered[0].id }); // ... but the move is bound to what the board APPLIED

    // The server's answer to that frame: the anchored staleness guard -- a catch-up, nothing applied.
    const answer = session.submit({ actor: owner, build: BUILD, msg: BUY_LOWEST, baseIndex: submit.baseIndex as number, baseId: submit.baseId as string, submissionId: "n1" });
    expect(answer.kind).toBe("catch-up");
    expect(session.nextIndex - 1).toBe(2); // the move did not land
    // ... and that answer, back over the wire to the link (as the server sends it: in reply to the submission), settles
    // the move NOT APPLIED and raises the stale sentence -- the shell's rollbacks act on exactly this `null`.
    socket.onmessage?.({ data: JSON.stringify({ ...answer, inReplyTo: submit.submissionId }) });
    expect(await move).toBeNull();
    expect(stale).toBe(1);

    // Once the board has applied everything, the same move is bound to the tip and is judged on the real board.
    applied = delivered;
    void link.submit(BUY_LOWEST);
    const second = wire.filter((frame) => frame.kind === "submit")[1];
    expect(second).toMatchObject({ baseIndex: 2, baseId: delivered[2].id });
    link.close();
  });

  it("a board that is not current sends nothing at all: the link settles the move null and says why", async () => {
    const wire: Array<Record<string, unknown>> = [];
    const refusals: string[] = [];
    const socket: SocketLike = { send: (data) => wire.push(JSON.parse(data)), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    const link = connectServerLink({
      url: "ws://test",
      gameId: GAME,
      build: BUILD,
      socketFactory: () => socket,
      onEntries: () => {},
      onRefused: (reason) => refusals.push(reason),
      appliedPosition: () => ({ notCurrent: BOARD_DIVERGED_NOTICE }),
    });
    socket.onopen?.({});
    socket.onmessage?.({ data: JSON.stringify({ kind: "catch-up", build: BUILD, digest: null, entries: [] }) });
    await expect(link.submit(BUY_LOWEST)).resolves.toBeNull();
    expect(wire.map((frame) => frame.kind)).toEqual(["hello"]);
    expect(refusals).toEqual([BOARD_DIVERGED_NOTICE]);
    expect(link.queue.unsettled).toBe(0);
    link.close();
  });

  it("a move queued while the wire was down is bound to the board as it stands when it goes out", async () => {
    const wire: Array<Record<string, unknown>> = [];
    const socket: SocketLike = { send: (data) => wire.push(JSON.parse(data)), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
    let position: { index: number; id: string | undefined } | { notCurrent: string } = { index: 4, id: "e4" };
    const link = connectServerLink({ url: "ws://test", gameId: GAME, build: BUILD, socketFactory: () => socket, onEntries: () => {}, appliedPosition: () => position });
    void link.submit(BUY_LOWEST); // no socket open yet: queued
    position = { index: 7, id: "e7" };
    socket.onopen?.({});
    expect(wire.find((frame) => frame.kind === "submit")).toMatchObject({ baseIndex: 7, baseId: "e7" });
    link.close();
  });
});

describe("W3-J AUD-25.16: shell wiring (source-pinned: the shell cannot be mounted in a unit test)", () => {
  const { readShell } = require("../utils/sourceScan") as typeof import("../utils/sourceScan");
  const shell = readShell();

  it("a board that is not current is nobody's turn (OD-19: a stale view of whose turn it is enables no move)", () => {
    const memo = shell.slice(shell.indexOf("const isMyTurn = useMemo(() => {"), shell.indexOf("}, [viewerAddress, gameState, waterfallState, scrubbing, boardCurrency]);"));
    expect(memo).toContain("if (!boardCurrency.current) return false;");
  });

  it("the forced notice is mounted with the board's currency and the two exits", () => {
    expect(shell).toContain("notice={sandbox && sandboxRoomCode && !boardCurrency.current ? boardCurrency.notice : null}");
    expect(shell).toContain("onReload={() => window.location.reload()}");
    expect(shell).toContain("onLeave={handleLeaveTableToLobby}");
  });

  it("a Watch tab leaves without acting for the seat, offers no Take a seat, and sends no room op (review MEDIUM)", () => {
    expect(shell).toContain('if (leaving && roomLost === null && !watchOnly) void roomOp({ type: "leave" }, leaving);');
    expect(shell).toContain("onTakeSeat={!watchOnly && !seated && !sandboxRoom.you.kicked && sandboxRoom.joinable ? handleTakeSeat : undefined}");
    const op = shell.slice(shell.indexOf("const runRoomOp = useCallback("), shell.indexOf("const enterHostedGame = useCallback("));
    expect(op).toContain("if (watchOnly) {");
    expect(op).toContain("setSandboxRoomError(WATCHING_NO_SEAT);");
  });

  it("(review fix) a Watch tab's Leave goes back to the Lobby, so no table is hosted or joined inside a Watch tab", () => {
    const leave = shell.slice(shell.indexOf("const handleLeaveSandboxRoom = useCallback("), shell.indexOf("}, [roomLost, watchOnly, onLeaveGame]);"));
    expect(leave).toContain("if (watchOnly) onLeaveGame();");
    // After the shell has forgotten the table (the gate's Host / Join would otherwise follow).
    expect(leave.indexOf("if (watchOnly) onLeaveGame();")).toBeGreaterThan(leave.indexOf("setSandboxRoomCode(null);"));
  });
});
