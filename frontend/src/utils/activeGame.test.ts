/** @jest-environment jsdom */
// frontend/src/utils/activeGame.test.ts
//
// ==================================================================
//  LIVE-2D: THE RESUME POINTER IS A GAME ID, AND THE CLIENT PERSISTS NO IDENTITY
// ==================================================================
//
// REPLACES `seatPin.test.ts` and `sandboxWatchIntent.test.ts`. Those pinned a client that minted and stored its own
// `p-…` player id (which was also its seat), a per-room seat PIN and seat token, and a watch intent that held back
// the shell's auto-seat. All of that is deleted: who this tab is lives in the HttpOnly session cookie (or a
// development tab's claim), which seat it holds is the server's GameRecord, and entering a table never takes a seat.
// What the browser keeps is ONE pointer -- the table's server-minted `g_…` game id -- so a reload reopens the table,
// and the seat comes back with the session because it was never the browser's to keep.
//
// The authority properties pinned here:
//   - only a well-formed game id is ever stored or believed; anything else (a legacy `JUNO-XXX` code) is discarded;
//   - no principal, player id, seat PIN or seat token is written to storage, by any module, at any point;
//   - learning a seat from the server's RoomView stores nothing either.

import {
  ACTIVE_GAME_STORAGE_KEY,
  ACTIVE_SANDBOX_ROOM_STORAGE_KEY,
  forgetActiveTable,
  readActiveGame,
  readActiveSandboxRoom,
  writeActiveSandboxRoom,
} from "./activeGame";
import * as activeGame from "./activeGame";
import { socketUrlFor } from "./devIdentity";
import { resetRoomLinks, setRoomSocketFactory, watchRoom, type SocketLike } from "./roomLink";
import { readAppRoot, readStripped } from "./sourceScan";

const GAME = "g_0123456789abcdefghjkmnpqr0";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  resetRoomLinks();
  jest.restoreAllMocks();
});

/** Every key in both stores, for "nothing else was written" assertions. */
function storedKeys(): { session: string[]; local: string[] } {
  const keys = (store: Storage) => Array.from({ length: store.length }, (_unused, index) => store.key(index) as string).sort();
  return { session: keys(window.sessionStorage), local: keys(window.localStorage) };
}

describe("the resume pointer is the table's game id, and nothing else is believed (LIVE-2D)", () => {
  it("stores a game id in the session -- never in localStorage, which would outlive the session that earned it", () => {
    writeActiveSandboxRoom(GAME);
    expect(window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBe(GAME);
    expect(readActiveSandboxRoom()).toBe(GAME);
    expect(storedKeys()).toEqual({ session: [ACTIVE_SANDBOX_ROOM_STORAGE_KEY], local: [] });
  });

  it("refuses to store anything that is not a game id, and clears the pointer instead", () => {
    writeActiveSandboxRoom(GAME);
    for (const value of ["JUNO-4T2", "JUNO-7K4M-Q2ZP", "p-0123456789abcdef", "", "g_NOT-A-GAME"]) {
      writeActiveSandboxRoom(GAME);
      writeActiveSandboxRoom(value);
      expect([value, window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)]).toEqual([value, null]);
    }
    writeActiveSandboxRoom(GAME);
    writeActiveSandboxRoom(null);
    expect(window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["a legacy room code from before LIVE-2D", "JUNO-4T2"],
    ["a join code (an invite, never a key)", "JUNO-7K4M-Q2ZP"],
    ["a player id", "p-0123456789abcdef"],
    ["a malformed game id", "g_0123456789abcdefghjkmnpqr1"],
    ["garbage", "{\"room\":\"JUNO-4T2\"}"],
  ])("discards %s found in storage, and lands on the Lobby", (_label, stored) => {
    window.sessionStorage.setItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY, stored);
    expect(readActiveSandboxRoom()).toBeNull();
    // Forgotten, not merely ignored: the next load does not have to discard it again.
    expect(window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBeNull();
  });

  it("fails closed when storage throws, rather than crashing the Lobby", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readActiveSandboxRoom()).toBeNull();
    expect(readActiveGame()).toBeNull();
    expect(() => writeActiveSandboxRoom(GAME)).not.toThrow();
  });

  it("resumes only a sandbox table: a stored `play` or `spectate` pointer is not a board to reopen", () => {
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
    expect(readActiveGame()).toEqual({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" });
    for (const mode of ["play", "spectate", undefined, "admin"]) {
      window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 7, roomId: "r-7", mode }));
      expect([mode, readActiveGame()]).toEqual([mode, null]);
    }
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, "{not json");
    expect(readActiveGame()).toBeNull();
  });

  it("the root seeds the table from this reader, and keeps no watch intent beside it", () => {
    /* APP-TEST-0A: class A. The seeding is GameRouter's -- the router's room pointer is the one piece of room
       state the decomposition keeps in App.tsx (audit §4.4, §12) -- so it is read from the root file alone. */
    const ROOT = readAppRoot(
      "GameRouter, in the composition root, holds the room pointer and seeds it from the session reader (#551)",
    );
    expect(ROOT).toContain("const [sandboxRoomCode, setSandboxRoomCode] = useState<string | null>(readActiveSandboxRoom);");
    const exported = Object.keys(activeGame);
    for (const gone of ["readSandboxWatchRoom", "writeSandboxWatchRoom", "SANDBOX_WATCH_ROOM_STORAGE_KEY", "writeSandboxResume"]) {
      expect([gone, exported.includes(gone)]).toEqual([gone, false]);
    }
  });
});

describe("the client persists no principal, player id, seat PIN or seat token (LIVE-2D)", () => {
  it("writes nothing but the pointer when it opens a socket and learns its seat from the server's view", () => {
    /* A production build: the socket URL carries no claim (the session cookie is the identity), and the seat the
       view names is PRESENTATION -- held in React state for "your turn", never written anywhere. */
    expect(socketUrlFor("wss://play.example/gs")).toBe("wss://play.example/gs");
    let socket: SocketLike | null = null;
    setRoomSocketFactory(() => {
      socket = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
      return socket;
    });
    writeActiveSandboxRoom(GAME);
    const seats: Array<string | null> = [];
    watchRoom(GAME, { onView: (view) => seats.push(view.you.playerId) });
    const live = socket as unknown as SocketLike;
    live.onopen?.();
    live.onmessage?.({
      data: JSON.stringify({
        kind: "room",
        gameId: GAME,
        view: { gameId: GAME, code: "JUNO-7K4M-Q2ZP", players: [], you: { role: "player", playerId: "p-0123456789abcdef", kicked: false, canStart: false } },
      }),
    });
    expect(seats).toEqual(["p-0123456789abcdef"]);
    expect(storedKeys()).toEqual({ session: [ACTIVE_SANDBOX_ROOM_STORAGE_KEY], local: [] });
    const everything = [...Array.from({ length: window.sessionStorage.length }, (_unused, i) => window.sessionStorage.getItem(window.sessionStorage.key(i) as string))];
    expect(everything.join(" ")).not.toContain("p-0123456789abcdef");
  });

  it("no source names the deleted identity keys, or the modules that kept them", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== "__fixtures__" && name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const needle of ["juno.sandbox.playerId", "juno.sandbox.seatPin", "juno.sandbox.seatToken", "juno.sandboxWatchRoom", "localPlayerId()", "/seatPin\"", "/roomDocLink\"", "/lobbyProtocol\"", "SeatPinModal"]) {
        if (code.includes(needle)) offenders.push(`${path.relative(root, file)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const gone of ["utils/seatPin.ts", "utils/roomDocLink.ts", "utils/lobbyProtocol.ts", "components/SeatPinModal.tsx"]) {
      expect([gone, fs.existsSync(path.join(root, gone))]).toEqual([gone, false]);
    }
  });

  it("every storage write in the client is on a reviewed list, and none holds a game-server principal or seat", () => {
    /* The allowlist is the whole set of places the client writes storage. A new write is a new line here, which
       is the moment to ask whether it stores who somebody is at a table. The development tab's claim is the one
       game-server identity, and it is written only inside the REACT_APP_DEV_IDENTITY branch (`devIdentity.test.ts`).
       (The wallet's cached address and chain session key are the wallet's, not the game server's.) */
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..");
    const writes: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== "__fixtures__" && name !== "node_modules") walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const code = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
          for (const match of Array.from(code.matchAll(/(?:sessionStorage|localStorage)\.setItem\(\s*([^,]+),/g))) {
            writes.push(`${path.relative(root, full).replace(/\\/g, "/")}: ${match[1].trim()}`);
          }
        }
      }
    };
    walk(root);
    expect(writes.sort()).toEqual(
      [
        "App.tsx: ACTIVE_GAME_STORAGE_KEY",
        "context/WalletContext.tsx: CACHED_ADDRESS_STORAGE_KEY",
        "utils/activeGame.ts: ACTIVE_SANDBOX_ROOM_STORAGE_KEY",
        "utils/audio.ts: STATION_STORAGE_KEY",
        "utils/devIdentity.ts: TAB_PRINCIPAL_KEY",
        "utils/introPreference.ts: KEY",
        "utils/lobby.ts: DISPLAY_NAME_STORAGE_KEY",
        /* W3-A / OD-5(a): the per-game notice acknowledgements, replacing App.tsx's `sessionStorage` dismissals. The key
           is the game's id and the seat's PUBLIC table position (`seat1`), never the seat's player id. */
        "utils/noticeAcknowledgements.ts: key",
        "utils/sessionKey.ts: SESSION_STORAGE_KEY",
        /* PHASE 3 FINAL PLAY TUTORIAL: the per-game tutorial ledger (the notice ledger's key shape: game id + the seat's
           PUBLIC table position, never a player id) and the browser's automatic-tutorial preference. They replace
           `TutorialModal.tsx`'s per-browser flags. */
        "tutorial/tutorialLedger.ts: TUTORIAL_AUTO_KEY",
        "tutorial/tutorialLedger.ts: key",
        "utils/uiScale.ts: UI_SCALE_STORAGE_KEY",
      ].sort(),
    );
  });
});

describe("signing out forgets the table (LIVE-2E)", () => {
  it("forgetActiveTable clears both resume pointers, so another profile on this tab is not sent to the last one's table", () => {
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
    writeActiveSandboxRoom("g_0123456789abcdefghjkmnpqr0");
    forgetActiveTable();
    expect(window.sessionStorage.getItem(ACTIVE_GAME_STORAGE_KEY)).toBeNull();
    expect(readActiveSandboxRoom()).toBeNull();
    const menu = readStripped("components/ProfileMenu.tsx");
    const notice = readStripped("components/SessionEndedNotice.tsx");
    expect(menu).toMatch(/forgetActiveTable\(\);\s*window\.location\.reload\(\)/);
    expect(notice).toMatch(/forgetActiveTable\(\);\s*window\.location\.reload\(\)/);
  });
});
