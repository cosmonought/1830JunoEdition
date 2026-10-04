// frontend/src/components/phase3W3GWatchDefect.test.tsx
//
/* ==================================================================
    PHASE 3 W3-G FOLLOW-UP (AUD-25.16): THE LOBBY'S "WATCH" OPENS A SEATED PRINCIPAL'S OWN SEAT, AND A BOARD
    AT REST BEHIND THE ROOM STILL OFFERS LIVE TURN CONTROLS -- TRIAGE ONLY
   ==================================================================
   OWNER-OBSERVED (2026-10-04): signed in as one of a game's players, the owner pressed "Watch" on that game's
   row in the Lobby's public list. The table opened in the owner's SEAT, one turn BEHIND the game, and offered
   the owner their turn from that stale position. The owner did not act.

   THESE ARE CHARACTERIZATION TESTS: they PASS today because they pin the DEFECT as it stands (no product
   code changes in this triage). W3-J's remediation flips the ones marked DEFECT; the ones marked KEEP pin
   behaviour the fix must not break (the Play / Rejoin path's seat). Nothing here touches a live game: the
   room is the in-memory `RoomSession`, the link a hand-driven fake socket, the shell read by source scan.

   Three separate facts (AUD-25.16 records them separately):
     (A) WATCH IDENTITY -- Watch and "Your tables" are ONE door (`onEnterSandbox(gameId)`); no watch intent
         reaches the shell or the server, and the seat is the server's answer by principal (`roomViewFor`),
         so a seated principal who presses Watch is in their seat, against the button's own promise
         ("Watch this game. You will not have a seat.").
     (B) STALE AT REST -- the drain advances its cursor BEFORE dispatching each replayed entry and nothing
         retries an entry the shell failed to apply (a reducer no-op / refusal or a throw); on a fresh entry
         the first board comparison is muted (`everAgreed` false -> console only), so a board can rest behind
         the room with no notice.
     (C) ACTIONABLE WHILE STALE -- the only "is this board current?" gate is `replayingRef` (a drain in
         progress); the turn gate reads the shell's own board, and the link stamps a click with the index it
         RECEIVED, not the one the shell applied -- so the server's staleness guard does not fire and the
         move is judged against a board the player never saw (refused, or APPLIED when it happens to be
         legal there). */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LobbyRoomList } from "./LobbyRoomList";
import { MyTablesList } from "./MyTablesList";
import { STANDARD_VARIANTS } from "../gameEngine/gameVariants";
import type { MyTableSummary, RoomSummary } from "../utils/roomProtocol";
import { divergenceVerdict } from "../utils/divergenceWatch";
import { expectOrder, readShell, readStripped, sliceBetween } from "../utils/sourceScan";

const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const { connectServerLink } = require("../utils/serverLink") as typeof import("../utils/serverLink");
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
});
const render = (node: React.ReactElement) => act(() => root.render(node));

/** The server's own source (not the shell): read directly; the shell is read only through `readShell()`. */
const serverSource = (relative: string) =>
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "server", "src", relative), "utf8");

/* ------------------------------------------------------------------ (A) WATCH IDENTITY */

describe("AUD-25.16 (A): Watch identity", () => {
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

  it("DEFECT: the Watch button promises no seat, yet hands the shell only the game id -- the same value the Play / Rejoin door hands it", () => {
    const watched: string[] = [];
    const opened: string[] = [];
    render(
      <>
        <MyTablesList tables={[myTable]} error={null} onOpen={(id) => opened.push(id)} />
        <LobbyRoomList rooms={[publicRow]} loading={false} error={null} available busy={false} refusal={null} onJoin={() => {}} onWatch={(id) => watched.push(id)} />
      </>,
    );
    const watch = host.querySelector('[data-testid="lobby-watch-JUNO-1A1"]') as HTMLButtonElement;
    expect(watch.title).toBe("Watch this game. You will not have a seat.");
    act(() => watch.click());
    const rejoin = host.querySelector('[data-testid="my-table-row"] button') as HTMLButtonElement;
    act(() => rejoin.click());
    // One door: the same bare game id, no role, no intent. The seated principal's own table is listed in
    // "Your tables" AND offered "Watch" in the public list, and the two cannot be told apart downstream.
    expect(watched).toEqual([GAME]);
    expect(opened).toEqual([GAME]);
  });

  it("DEFECT: the Lobby wires Watch and Your tables to the same `onEnterSandbox`, and the shell's door carries no watch intent", () => {
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("onOpen={(gameId) => onEnterSandbox(gameId)}");
    expect(lobby).toContain("onWatch={(gameId) => onEnterSandbox(gameId)}");
    const shell = readShell();
    const door = sliceBetween(shell, "const handleEnterSandbox = useCallback((gameIdToEnter: string) => {", "}, []);");
    expect(door).toContain("setSandboxRoomCode(gameIdToEnter);");
    expect(door).toContain('setActiveGame({ gameId: SANDBOX_GAME_ID, roomId: SANDBOX_ROOM_ID, mode: "sandbox" });');
    // Every Lobby door opens `mode: "sandbox"`; the shell's `spectate` mode is never chosen by Watch.
    expect(door).not.toContain('"spectate"');
  });

  it("DEFECT: the seat is the server's answer by principal, whatever door opened the table (`roomViewFor`)", () => {
    const record = serverSource("rooms/gameRecord.ts");
    const view = sliceBetween(record, "export function roomViewFor(", "const insider =");
    expect(view).toContain("const seat = seatOf(record, principalId);");
    expect(view).toContain('const role: RoomView["you"]["role"] = host ? "host" : seat !== null ? "player" : member ? "member" : "viewer";');
    // ... and the shell's identity is that answer: a seated principal is "player"/"host" and acts as the seat.
    const shell = readShell();
    expect(shell).toContain('const localId = sandboxRoomDoc?.you.playerId ?? "";');
    expect(shell).toContain("const viewerAddress = sandbox ? localId : wallet.address;");
  });

  it("DEFECT: the log hello names no role -- nothing on the wire says this tab came to watch", () => {
    const wire: string[] = [];
    const socket = { send: (data: string) => wire.push(data), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null } as import("../utils/serverLink").SocketLike;
    const link = connectServerLink({ url: "ws://test", gameId: GAME, build: "build-1", onEntries: () => {}, socketFactory: () => socket });
    socket.onopen?.({});
    const hello = JSON.parse(wire[0]) as Record<string, unknown>;
    expect(hello.kind).toBe("hello");
    expect(Object.keys(hello).sort()).toEqual(["baseIndex", "build", "gameId", "kind"]);
    link.close();
  });

  it("KEEP: the Play / Rejoin door ('Your tables') reopens the principal's own seat -- the fix must leave that path as it is", () => {
    const opened: string[] = [];
    render(<MyTablesList tables={[myTable]} error={null} onOpen={(id) => opened.push(id)} />);
    act(() => (host.querySelector('[data-testid="my-table-row"] button') as HTMLButtonElement).click());
    expect(opened).toEqual([GAME]);
    // Reconnect-to-seat is the server's principal -> seat answer (pinned above) plus the hello's `baseIndex`
    // catch-up; a submit names no actor (the server derives it), so a rejoined seat acts as itself.
    const gameServer = serverSource("gameServer.ts");
    expect(gameServer).toContain("const subscribed = game.subscribe(socket, ownedSubscriberFor(socket, gameId, ctx.principalId, game), fromIndex, baseId);");
  });
});

/* ------------------------------------------------------------------ (B) STALE AT REST */

describe("AUD-25.16 (B): a board can rest behind the room with no notice", () => {
  it("DEFECT: the drain counts an entry applied BEFORE dispatching it, with no catch around the dispatch", () => {
    const shell = readShell();
    const loop = sliceBetween(shell, "for (let at = appliedCountRef.current; at < history.length; at += 1) {", "if (live) setSandboxAppliedCount(appliedCountRef.current);");
    expectOrder(loop, "appliedCountRef.current = at + 1;", 'await runGameplayActionRef.current?.("Sandbox room", msg, {');
    // try/finally only: a throw on the last entry ends the pass with the cursor already past it, and nothing retries it.
    expect(loop).not.toMatch(/\bcatch\s*\(/);
  });

  it("DEFECT: on a fresh entry the first board comparison is muted -- a mismatch is a console note, never a banner", () => {
    const first = divergenceVerdict({ serverDigest: "a".repeat(16), clientDigest: "b".repeat(16), appliedIndex: 41, reportedAt: null, everAgreed: false });
    expect(first.diverged).toBe(true);
    expect(first.message).toBeNull();
    expect(first.note).toMatch(/have not agreed/);
  });
});

/* ------------------------------------------------------------------ (C) ACTIONABLE WHILE STALE */

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
  const submit = (actor: string, msg: never, baseIndex = session.nextIndex - 1) =>
    session.submit({ actor, build: BUILD, msg, baseIndex });
  return { session, submit };
}

describe("AUD-25.16 (C): controls stay live on a stale board, and a click reaches the server", () => {
  it("DEFECT: the only currentness gate is a drain in progress; the turn gate reads the shell's own board", () => {
    const shell = readShell();
    expect(shell).toMatch(/options\?\.isRemoteReplay !== true &&\s*options\?\.automatic !== true &&\s*replayingRef\.current/);
    expect(shell).toContain("actingAddress(boardNow, sandboxWaterfallRef.current) === viewerAddressRef.current");
  });

  it("DEFECT: the link stamps a click with the index it RECEIVED, even when the shell never applied it", () => {
    const wire: string[] = [];
    const socket = { send: (data: string) => wire.push(data), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null } as import("../utils/serverLink").SocketLike;
    let ids = 0;
    const link = connectServerLink({
      url: "ws://test",
      gameId: GAME,
      build: "build-1",
      // The shell "applies" nothing here: whatever happens to the entries downstream, the link has moved on.
      onEntries: () => {},
      socketFactory: () => socket,
      mintSubmissionId: () => `n${(ids += 1)}`,
    });
    socket.onopen?.({});
    const tip = [0, 1, 2].map((index) => ({ index, id: `e${index}`, actor: "p-owner", payload: "{}" }));
    socket.onmessage?.({ data: JSON.stringify({ kind: "catch-up", build: "build-1", digest: "0".repeat(16), entries: tip }) });
    void link.submit({ PassTurn: { game_id: 0 } } as never);
    const submits = wire.map((text) => JSON.parse(text) as Record<string, unknown>).filter((frame) => frame.kind === "submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]).toMatchObject({ baseIndex: 2, baseId: "e2" });
    // And the link asks for nothing on its own: only the hello and the click went out.
    expect(wire.map((text) => (JSON.parse(text) as { kind: string }).kind)).toEqual(["hello", "submit"]);
    link.close();
  });

  it("KEEP (the protective path): a click stamped with a stale index IS answered as a catch-up", () => {
    const { session, submit } = room();
    expect(submit("p-owner", SETUP).kind).toBe("applied");
    const first = session.state.player_addresses[0];
    expect(submit(first, BUY_LOWEST).kind).toBe("applied"); // index 1
    expect(submit(first, BUY_LOWEST, 0).kind).toBe("catch-up");
  });

  it("DEFECT: the same click stamped with the link's tip passes the staleness guard and is judged on a board the player never saw", () => {
    const { session, submit } = room();
    expect(submit("p-owner", SETUP).kind).toBe("applied"); // 0
    const [first, second] = session.state.player_addresses;
    // The stale board the tab rests on: index 0, `first` on turn -- the turn prompt the owner saw.
    expect(submit(first, BUY_LOWEST).kind).toBe("applied"); // 1 (the entry the tab never applied)
    // Not stale (baseIndex = tip), so it reaches the authority and is refused there -- the server, not the stale guard, answers.
    const refused = submit(first, BUY_LOWEST);
    expect(refused.kind).toBe("refused");
    // And when the missed entries hand the turn back, the click LANDS on the real board.
    expect(submit(second, BUY_LOWEST).kind).toBe("applied"); // 2
    const landed = submit(first, BUY_LOWEST); // the tab still shows index 0
    expect(landed.kind).toBe("applied");
    if (landed.kind === "applied") expect(landed.entries[0].index).toBe(3);
  });
});
