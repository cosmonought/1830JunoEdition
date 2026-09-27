/** @jest-environment node */
// frontend/src/utils/myTables.test.ts -- LIVE-2F/3D (C9-01, C9-03): the way back to a seat.
//
// A seat belongs to the profile; before this pass the only pointer to it was the tab's own sessionStorage, so a player
// who closed the tab, linked a device, recovered onto a new browser, signed out and in, or pressed "← Lobby" could not
// reach a private table (or an in-progress public one after a restart) from anything on screen. The lobby now asks the
// server which tables the profile sits at and offers each one; the hold screen says what the server said instead of
// "Fetching" for ever. Asked of the pure derivations and the wiring (source scans), as the lobby's other suites are.

import { readStripped } from "./sourceScan";
import { myTableLabel, myTablesOf, type MyTableState, type MyTableSummary } from "./roomProtocol";
import { myTableTitle } from "../components/MyTablesList";
import { parseClientFrame } from "../gameEngine/messageSchema";

const GAME = `g_${"a".repeat(25)}0`;

const table = (over: Partial<MyTableSummary> = {}): MyTableSummary => ({
  gameId: GAME,
  state: "playing",
  visibility: "private",
  hostNickname: "Ann",
  nicknames: ["Ann", "Bea"],
  you: "player",
  createdAtMs: 1,
  lastActivityMs: 2,
  ...over,
});

describe("LIVE-2F/3D C9-01: Your tables", () => {
  test("the server's answer is read field by field; anything malformed or unknown is dropped, never guessed at", () => {
    const good = table();
    expect(myTablesOf({ tables: [good] })).toEqual([good]);
    expect(myTablesOf({ tables: [{ ...good, gameId: "JUNO-AAAA-AAAA" }] })).toEqual([]);
    expect(myTablesOf({ tables: [{ ...good, state: "stolen" }] })).toEqual([]);
    expect(myTablesOf({ tables: [{ ...good, you: "owner" }] })).toEqual([]);
    expect(myTablesOf({ tables: [{ ...good, nicknames: [1] }] })).toEqual([]);
    expect(myTablesOf({ tables: "nope" })).toEqual([]);
    expect(myTablesOf({})).toEqual([]);
  });

  test("every state has a status and a button a player can read", () => {
    const states: MyTableState[] = ["waiting", "playing", "finished", "resume", "paused", "unavailable", "cannot-continue", "watch-only"];
    for (const state of states) {
      const label = myTableLabel(state);
      expect(label.status.length).toBeGreaterThan(0);
      expect(label.action.length).toBeGreaterThan(0);
      expect(`${label.status} ${label.action}`).not.toMatch(/guest|unreconciled|devtools|console/i);
    }
    expect(myTableLabel("playing").action).toBe("Return to table");
    expect(myTableLabel("resume").action).toBe("Return to table");
  });

  test("a row names the table by its people, never by an id", () => {
    expect(myTableTitle(table())).toBe("Ann's table · with Bea");
    expect(myTableTitle(table({ you: "host" }))).toBe("Your table · with Bea");
    expect(myTableTitle(table({ you: "host", nicknames: ["Ann"] }))).toBe("Your table");
  });

  test("the lobby asks for the list (a read on the lobby channel, at most once a minute unless the page comes back) and each row opens its table by game id", () => {
    const LOBBY = readStripped("components/Lobby.tsx");
    const LIST = readStripped("components/MyTablesList.tsx");
    const DATA = readStripped("utils/lobby.ts");
    expect(LOBBY).toContain("const myTables = useMyTables();");
    expect(LOBBY).toMatch(/<MyTablesList tables=\{myTables\.tables\} error=\{myTables\.error\} onOpen=\{\(gameId\) => onEnterSandbox\(gameId\)\} \/>/);
    expect(LIST).toContain("onClick={() => onOpen(table.gameId)}");
    expect(DATA).toContain('roomOp({ type: "my-tables" })');
    expect(DATA).toContain("export const MY_TABLES_REFRESH_MS = 60_000;");
    expect(DATA).toContain('document.addEventListener("visibilitychange", onVisible)');
    /* Independent review IR-08: a page's return to view asks again at most every 15 s (the read shares the lobby
       socket's room-op budget with Create and Join). */
    expect(DATA).toContain("export const MY_TABLES_VISIBLE_MIN_MS = 15_000;");
    expect(DATA).toContain("Date.now() - lastAsked >= MY_TABLES_VISIBLE_MIN_MS");
  });

  test("the closed schema takes the read with no game and nothing else in it", () => {
    expect(parseClientFrame({ kind: "room-op", requestId: "r1", op: { type: "my-tables" } }).ok).toBe(true);
    expect(parseClientFrame({ kind: "room-op", requestId: "r1", op: { type: "my-tables", principal: "pr_x" } }).ok).toBe(false);
  });
});

describe("LIVE-2F/3D C9-03: the first-open hold says what the server said", () => {
  test("the hold screen shows the server's sentence (an unavailable or held table) instead of Fetching for ever", () => {
    const WAITING = readStripped("components/SandboxWaitingRoom.tsx");
    const APP = readStripped("App.tsx");
    expect(WAITING).toContain('{error ?? "Fetching the room…"}');
    expect(APP).toMatch(/<SandboxWaitingRoomHold\s+roomCode=""\s+audio=\{audioControls\}\s+onLeave=\{handleLeaveSandboxRoom\}\s+error=\{sandboxRoomError\}/);
  });
});
