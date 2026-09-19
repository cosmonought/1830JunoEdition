/** @jest-environment jsdom */
// frontend/src/utils/sandboxWatchIntent.test.ts -- design note #1442.
//
// ==================================================================
//  THE WATCH INTENT, AT THE NAVIGATION BOUNDARY
// ==================================================================
//
// #1441 gave the shell an explicit "this arrival is a watch" so the seat claim could be held on a table that
// is still WAITING. It travelled as a boolean prop, and a boolean is wrong at exactly two moments -- both of
// them a navigation, neither of them visible from inside a single screen:
//
//   THE WRONG ROOM. `AppShell`'s key is the game and the mode, both constant for the sandbox, so leaving a
//   room and joining another FROM THE SHELL'S OWN GATE does not remount it. A `true` granted for room A was
//   still in force when the shell was looking at room B, and suppressed B's seat claim.
//
//   THE WRONG DIRECTION ON A REFRESH. `writeActiveSandboxRoom` persists a watcher's room like anybody else's,
//   so a reload restored the room with the intent reset to false -- and seated the watcher at a table they had
//   asked only to look at, where they then count toward the host's start gate. The worse of the two, because
//   it CREATES a seat nobody asked for rather than withholding one somebody did.
//
// BOTH ARE THE SAME FIX: the intent is the room code it was granted for, stored beside the room pointer it
// qualifies. This file holds the boundary cases; `lobbyPublicRooms.test.ts` holds the wiring.

import {
  ACTIVE_GAME_STORAGE_KEY,
  SANDBOX_WATCH_ROOM_STORAGE_KEY,
  readActiveSandboxRoom,
  readSandboxWatchRoom,
  writeActiveSandboxRoom,
  writeSandboxResume,
  writeSandboxWatchRoom,
} from "./activeGame";
import { readStripped } from "./sourceScan";

const APP = readStripped("App.tsx");

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the intent is a room, and it survives exactly one arrival (design note #1442)", () => {
  it("keeps the watch room beside the room pointer, in the session", () => {
    /* `sessionStorage`, for the reason the room pointer gives: in `localStorage` this would outlive the
       identity that earned it, and a tab weeks later would hold back a seat in a room it cannot remember. */
    expect(SANDBOX_WATCH_ROOM_STORAGE_KEY).toBe("juno.sandboxWatchRoom");
    writeSandboxWatchRoom("JUNO-4T2");
    expect(readSandboxWatchRoom()).toBe("JUNO-4T2");
    expect(window.localStorage.getItem(SANDBOX_WATCH_ROOM_STORAGE_KEY)).toBeNull();
    writeSandboxWatchRoom(null);
    expect(readSandboxWatchRoom()).toBeNull();
    expect(window.sessionStorage.getItem(SANDBOX_WATCH_ROOM_STORAGE_KEY)).toBeNull();
  });

  it("survives a reload, which is the whole reason it is stored at all", () => {
    /* The reload is not simulated by re-running the module -- it is simulated by the only thing that actually
       crosses it. A watcher's room is persisted like anybody's, so if the INTENT were not, the next load would
       restore the room with "seat me" as its default. */
    writeActiveSandboxRoom("JUNO-4T2");
    writeSandboxWatchRoom("JUNO-4T2");
    expect(readActiveSandboxRoom()).toBe("JUNO-4T2");
    expect(readSandboxWatchRoom()).toBe("JUNO-4T2");
    // And the root seeds its state from exactly this reader rather than from `false`.
    expect(APP).toContain("useState<string | null>(readSandboxWatchRoom)");
  });

  it("is retired by a resume, because a resume is a seated arrival by definition", () => {
    /* #1352's "Rejoin seat" writes both keys and reloads. A player who watched a table and then reclaimed
       their seat in it would otherwise reload holding a reason not to be seated. */
    writeSandboxWatchRoom("JUNO-4T2");
    writeSandboxResume("JUNO-4T2");
    expect(readActiveSandboxRoom()).toBe("JUNO-4T2");
    expect(readSandboxWatchRoom()).toBeNull();
    expect(window.sessionStorage.getItem(ACTIVE_GAME_STORAGE_KEY)).toContain("sandbox");
  });

  it("is retired by adopting a seat, on the one path that does not go through the resume writer", () => {
    /* `SeatPinModal` adopts from INSIDE the room and reloads without `writeSandboxResume` (the session already
       points at the room). `adoptSeat` is the act both paths share, so the clear belongs there too -- written
       as a literal because that module is a deliberate leaf, exactly as `forgetSeat` beside it already does. */
    const seatPin = readStripped("utils/seatPin.ts");
    expect(seatPin).toContain('window.sessionStorage.removeItem("juno.sandboxWatchRoom");');
    const adopt = seatPin.slice(seatPin.indexOf("export function adoptSeat("));
    expect(adopt.slice(0, adopt.indexOf("\n}"))).toContain("juno.sandboxWatchRoom");
    // The leaf rule still holds: it may not import the module that owns the key.
    expect(seatPin).not.toContain('from "./activeGame"');
  });

  it("does not throw where the session store is closed", () => {
    /* Private browsing. The bargain `readActiveSandboxRoom` already makes: the watch works for this load and
       is not resumable -- and it fails toward "ask for a seat", which is the recoverable half. */
    const store = window.sessionStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("denied");
      },
    });
    expect(() => writeSandboxWatchRoom("JUNO-4T2")).not.toThrow();
    expect(readSandboxWatchRoom()).toBeNull();
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: store });
  });
});

describe("the shell consumes it for one room and retires it for any other (design note #1442)", () => {
  it("holds a live copy rather than reading the prop forever", () => {
    /* A COPY, because the gate below can change the room without this shell remounting: an intent only the
       ROOT could retire would still be in force when it did. Held here, it expires the moment the shell looks
       at anything else -- including at nothing, which is what "Back to the lobby" from the gate leaves. */
    expect(APP).toContain("const [sandboxWatchRoom, setSandboxWatchRoom] = useState<string | null>(sandboxWatchSeed);");
    expect(APP).toContain("if (sandboxWatchRoom === null || sandboxWatchRoom === sandboxRoomCode) return;");
    expect(APP).toContain("setSandboxWatchRoom(null);");
    expect(APP).toContain("writeSandboxWatchRoom(null);");
  });

  it("compares rooms rather than testing a flag, which is what makes it one-shot", () => {
    expect(APP).toContain("sandboxWatchRoom === sandboxRoomCode ||");
    // The flag form is gone in both of its spellings, so neither can come back by a partial revert.
    expect(APP).not.toContain("sandboxWatchOnly");
    expect(APP).not.toContain("sandboxWatchSeed ||");
    expect(APP).not.toContain("sandboxWatchSeed?: boolean");
    // And the effect re-reads it, so a retirement takes effect on the render that caused it.
    expect(APP).toContain("localId, sandboxWatchRoom]);");
  });

  it("writes the intent on EVERY entry, which is what stops it going stale", () => {
    /* Host, Join, the code box and Watch all arrive at one handler, and only Watch arrives with a room. A
       refused join never reaches it at all -- and cannot, because it returns before `onEnterSandbox`. */
    expect(APP).toContain("const watching = watchOnly === true ? code : null;");
    expect(APP).toContain("setSandboxWatchRoom(watching);");
    expect(APP).toContain("writeSandboxWatchRoom(watching);");
    const lobby = readStripped("components/Lobby.tsx");
    expect(lobby).toContain("onWatch={(code) => onEnterSandbox(code, true)}");
    // The three seated doors pass no second argument, so each one clears the intent as it arrives.
    for (const call of [
      "onEnterSandbox(code);",
    ]) {
      expect(lobby).toContain(call);
    }
    expect(lobby).not.toContain("onEnterSandbox(code, false)");
    // A refusal returns before the entry, so there is nothing to leave behind.
    expect(lobby).toContain("setSandboxRoomError(answer.reason);");
    expect(lobby).toContain("return answer.reason;");
  });
});
