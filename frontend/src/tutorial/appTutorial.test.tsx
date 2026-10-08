/** @jest-environment jsdom */
// frontend/src/tutorial/appTutorial.test.tsx -- PHASE 3 FINAL PLAY TUTORIAL: APP-LEVEL PROOF.
//
// THE REAL <App/>: GameRouter routes straight into the hosted room's AppShell, the room view arrives through the
// real `watchRoom` listener, and the log arrives through the real link callback with the frame kind the server would
// send -- `applied` for live play, `catch-up` for history -- drained by the shell's own drain into its own reducer.
// The entries and digests are minted by the server's own engine (`RoomSession`). Only the two transports are stubbed.
// What is proven here is the WIRING: live vs catch-up, the coach's arbitration with the films and the native dialogs,
// and the per-seat, per-game persistence -- the parts unit tests of the pieces cannot see.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// config.ts reads the server URL at module load; App is require()d inside each test, after this line.
process.env.REACT_APP_GAME_SERVER_URL = "ws://tutorial.test";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const captured: { link: Any; view: Any } = { link: null, view: null };
jest.mock("../utils/serverLink", () => {
  const actual = jest.requireActual("../utils/serverLink");
  return {
    ...actual,
    connectServerLink: (options: Any) => {
      captured.link = options;
      return { submit: async () => null, appliedIndex: -1, resyncs: 0, queue: actual.IDLE_LINK_QUEUE, close: () => {} };
    },
  };
});
jest.mock("../utils/roomLink", () => {
  const actual = jest.requireActual("../utils/roomLink");
  return {
    ...actual,
    roomLinkAvailable: () => true,
    watchRoom: (_gameId: string, listener: Any) => {
      captured.view = listener;
      return () => {};
    },
    watchRoomLink: () => () => {},
    watchPublicRooms: () => () => {},
    subscribeChat: () => () => {},
    subscribePresence: () => () => {},
    sendPresence: () => {},
    sendChat: () => {},
    roomOp: async () => ({ ok: true }),
  };
});

const GAME = "g_0123456789abcdefghjkmnpqr0";
const OTHER_GAME = "g_9123456789abcdefghjkmnpqr0";
const BUILD = "tutorial-app-build";
const SETUP = { SetupGame: { players: [{ id: "p-owner", nickname: "Owner" }, { id: "p-bea", nickname: "Bea" }], variants: {} } };
const recordKey = (game: string, seat: number) => `1830juno.tutorial.v2.${game}.seat${seat}`;

function makeRoom() {
  const { RoomSession } = require("../utils/roomSession");
  const { sandboxReplayProviders } = require("../gameEngine/replayProviders");
  const { DEFAULT_SANDBOX_SCENARIO, sandboxScenario, sandboxScenarioState, sandboxWaterfallState } = require("../gameEngine/sandboxState");
  const { waterfallForRoster, withEmptyRoster } = require("../gameEngine/gameSetup");
  let n = 0;
  return new RoomSession({
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `id${(n += 1)}`,
    now: () => 1_000 + n,
  });
}

function view(gameId: string, playerId: string | null, status: "waiting" | "playing") {
  return {
    gameId,
    code: "JUNO-AAAA-BBBB",
    joinable: status === "waiting",
    visibility: "private",
    status,
    lifecycle: status,
    closed: false,
    held: false,
    holdKind: null,
    hostId: "p-owner",
    players: [
      { id: "p-owner", nickname: "Owner", isReady: true, online: true },
      { id: "p-bea", nickname: "Bea", isReady: true, online: true },
    ],
    playerCount: 2,
    seatCap: 2,
    variants: require("../gameEngine/gameVariants").resolveVariants({}),
    createdAtMs: 0,
    undoPolicy: "free",
    you: { role: playerId ? "player" : "viewer", playerId, kicked: false, canStart: false },
  };
}

let host: HTMLDivElement;
let root: Root;
/* The first test pays for transforming App.tsx cold; the default 5s is not enough on a loaded machine. */
jest.setTimeout(60_000);
beforeAll(() => {
  Object.assign(window.HTMLMediaElement.prototype, { play: () => Promise.resolve(), pause: () => {}, load: () => {} });
  (globalThis as Any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const proto = window.HTMLDialogElement.prototype as Any;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  captured.link = null;
  captured.view = null;
  window.localStorage.clear();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  jest.restoreAllMocks();
});

let mountedPlayer: string | null = null;
async function mount(game: string, playerId: string | null, firstStatus: "waiting" | "playing") {
  mountedPlayer = playerId;
  window.sessionStorage.clear();
  window.sessionStorage.setItem("18cosmos.active_game.v1", JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
  window.sessionStorage.setItem("juno.activeSandboxRoom", game);
  const App = require("../App").default;
  await act(async () => {
    root.render(<App />);
  });
  expect(captured.link?.gameId).toBe(game);
  await act(async () => {
    captured.view.onView(view(game, playerId, firstStatus));
  });
}

/** The table starts: the room goes from waiting to playing (the intro's edge), and the deal arrives as live play. */
async function liveDeal(game: string) {
  const room = makeRoom();
  const deal = room.submit({ actor: "p-owner", build: BUILD, msg: SETUP as never, baseIndex: -1 }) as Any;
  await act(async () => {
    captured.view.onView(view(game, mountedPlayer, "playing"));
  });
  await act(async () => {
    captured.link.onEntries(deal.entries, deal.digest, null, "applied");
  });
  return room;
}

const coachTitle = () => document.querySelector("[data-tutorial-coach] h2")?.textContent ?? null;
const introUp = () => document.querySelector("[data-testid='game-intro-overlay'], video") !== null;
async function skipIntro() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
}
async function click(label: RegExp) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => label.test(node.textContent ?? ""));
  if (!button) throw new Error(`no button ${label}`);
  await act(async () => button.click());
}
const record = (game: string, seat: number) => {
  const raw = window.localStorage.getItem(recordKey(game, seat));
  return raw ? (JSON.parse(raw) as { acknowledged: string[]; pending: { id: string }[] }) : null;
};

describe("live play teaches; history never does", () => {
  it("a witnessed deal raises the orientation -- held under the intro film, shown when it ends", async () => {
    await mount(GAME, "p-owner", "waiting");
    await liveDeal(GAME);
    expect(introUp()).toBe(true);
    expect(coachTitle()).toBeNull(); // never under the film
    expect(record(GAME, 0)?.pending.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["orientation.goal", "orientation.flow", "auction.primer"]),
    );
    await skipIntro();
    expect(introUp()).toBe(false);
    expect(coachTitle()).toBe("What you are playing");
    // The board is not inert under the coach.
    expect(document.querySelector("[inert]")).toBeNull();
    await click(/^Got it$/);
    expect(coachTitle()).toBe("How a game unfolds");
    expect(record(GAME, 0)?.acknowledged).toEqual(["orientation.goal"]);
  });

  it("a late joiner / new device / reload catching up on history gets no backlog", async () => {
    const room = makeRoom();
    room.submit({ actor: "p-owner", build: BUILD, msg: SETUP as never, baseIndex: -1 });
    const history = room.catchUp(-1) as Any;
    await mount(GAME, "p-owner", "playing");
    await act(async () => {
      captured.link.onEntries(history.entries, history.digest, null, "catch-up");
    });
    expect(coachTitle()).toBeNull();
    expect(record(GAME, 0)).toBeNull();
  });

  it("a reload restores what was witnessed and unanswered, and never repeats what was answered", async () => {
    await mount(GAME, "p-owner", "waiting");
    const room = await liveDeal(GAME);
    await skipIntro();
    await click(/^Got it$/); // orientation.goal answered; the rest still pending
    const pendingBefore = record(GAME, 0)!.pending.map((entry) => entry.id);
    expect(pendingBefore.length).toBeGreaterThanOrEqual(2);
    await act(async () => root.unmount());
    root = createRoot(host);
    const history = room.catchUp(-1) as Any;
    await mount(GAME, "p-owner", "playing");
    await act(async () => {
      captured.link.onEntries(history.entries, history.digest, null, "catch-up");
    });
    expect(coachTitle()).toBe("How a game unfolds");
    expect(record(GAME, 0)?.acknowledged).toEqual(["orientation.goal"]);
    /* Review C, MEDIUM: between the room view and the catch-up the board on screen is the seed; nothing pending may be
       withdrawn against it. Every lesson still waits -- the round's primer and any decision lesson included. */
    expect(record(GAME, 0)!.pending.map((entry) => entry.id)).toEqual(pendingBefore);
  });

  it("a reload that has not caught up yet withdraws nothing", async () => {
    await mount(GAME, "p-owner", "waiting");
    await liveDeal(GAME);
    await skipIntro();
    const pendingBefore = record(GAME, 0)!.pending.map((entry) => entry.id);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(GAME, "p-owner", "playing"); // the room view, but no log yet
    expect(record(GAME, 0)!.pending.map((entry) => entry.id)).toEqual(pendingBefore);
    expect(coachTitle()).toBe("What you are playing"); // the orientation needs no board
  });
});

describe("who is taught, and where progress lives", () => {
  it("a watcher receives no automatic tutorial, but can open the library", async () => {
    await mount(GAME, null, "waiting");
    await liveDeal(GAME);
    await skipIntro();
    expect(coachTitle()).toBeNull();
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("1830juno.tutorial.v2."))).toEqual([]);
    await click(/Tutorials/);
    expect(document.querySelector("dialog[open]")?.getAttribute("aria-label")).toBe("Tutorials");
  });

  it("another seat in the same game, and the same seat in another game, are taught afresh", async () => {
    window.localStorage.setItem(recordKey(GAME, 0), JSON.stringify({ v: 2, updatedAt: 1, acknowledged: ["orientation.goal", "orientation.flow"], pending: [] }));
    await mount(GAME, "p-bea", "waiting");
    await liveDeal(GAME);
    await skipIntro();
    expect(coachTitle()).toBe("What you are playing"); // seat 1's own record
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(OTHER_GAME, "p-owner", "waiting");
    await liveDeal(OTHER_GAME);
    await skipIntro();
    expect(coachTitle()).toBe("What you are playing"); // game A's progress does not suppress game B
  });
});

describe("arbitration and settings through the real shell", () => {
  it("a native dialog (the library) takes the screen; the coach waits, unanswered, and returns", async () => {
    await mount(GAME, "p-owner", "waiting");
    await liveDeal(GAME);
    await skipIntro();
    expect(coachTitle()).toBe("What you are playing");
    await click(/^Tutorials$/); // the coach's own link opens the library
    expect(document.querySelector("dialog[open]")?.getAttribute("aria-label")).toBe("Tutorials");
    expect(coachTitle()).toBeNull();
    await click(/^Close$/);
    expect(coachTitle()).toBe("What you are playing");
    expect(record(GAME, 0)?.acknowledged).toEqual([]);
  });

  it("turning automatic tutorials off hides the coach; the library turns them back on; Restart teaches this game again", async () => {
    await mount(GAME, "p-owner", "waiting");
    await liveDeal(GAME);
    await skipIntro();
    await click(/Turn off automatic tutorials/);
    expect(coachTitle()).toBeNull();
    await click(/Tutorials/);
    const toggle = document.querySelector<HTMLInputElement>("[data-testid='tutorial-auto-toggle']")!;
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    await click(/Restart tutorials for this game/);
    await click(/^Close$/);
    expect(coachTitle()).toBe("What you are playing");
  });
});
