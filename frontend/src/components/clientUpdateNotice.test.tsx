/** @jest-environment jsdom */
//
// LIVE-4 (L4-3): THE CLIENT-UPDATE NOTICE. The page's port reloads once by itself; this notice is what the player sees
// when it will not -- the same answer came back after the reload, the page cannot remember that it tried, or a route
// could not be followed. It renders nothing otherwise; it says why in plain words (no internal code, no version
// number); its one button reloads the page, and nothing else is written but the port's own marker.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ClientUpdateNotice } from "./ClientUpdateNotice";
import {
  CLIENT_UPDATE_STORAGE_KEY,
  MAX_ROUTE_HOPS,
  createBrowserClientUpdatePort,
  createClientUpdatePort,
  type ClientUpdatePort,
  type MarkerStorage,
} from "../utils/clientUpdate";
import { anchorIndex, readStripped } from "../utils/sourceScan";
import { ACTIVE_GAME_STORAGE_KEY, ACTIVE_SANDBOX_ROOM_STORAGE_KEY } from "../utils/activeGame";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const GAME = "g_0123456789abcdefghjkmnpqr0";

/** A tab's storage, played by the test (`null` = the page has none). */
function memoryStorage(): MarkerStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => (items.has(key) ? (items.get(key) as string) : null),
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

function page(storage: MarkerStorage | null) {
  const reloads: number[] = [];
  const assigned: string[] = [];
  const forgotten: number[] = [];
  let clock = 1_000_000;
  const port = createClientUpdatePort({
    storage,
    navigate: { reload: () => reloads.push(clock), assign: (url) => assigned.push(url) },
    now: () => clock,
    forgetTable: () => forgotten.push(clock),
  });
  return {
    port,
    reloads,
    assigned,
    forgotten,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = (port: ClientUpdatePort) => act(() => root.render(<ClientUpdateNotice port={port} />));
const notice = () => container.querySelector('[data-testid="client-update-notice"]');
const reloadButton = () => container.querySelector('[data-testid="client-update-reload"]') as HTMLButtonElement | null;
const lobbyButton = () => container.querySelector('[data-testid="client-update-lobby"]') as HTMLButtonElement | null;

/** What a player must never read on this notice: an internal code, a close code, a version number, a raw reason. */
function expectPlainWords(text: string) {
  expect(text).not.toMatch(/client-(protocol|rules|announcement)|route-unavailable|legacy|4426|\bcp\b|\bcr\b|\bcb\b/);
  expect(text).not.toMatch(/\d/);
  expect(text).not.toMatch(/undefined|null|\[object/);
}

describe("ClientUpdateNotice", () => {
  it("renders nothing while nothing asks the player -- idle, or while the page itself reloads once", () => {
    const storage = memoryStorage();
    const tab = page(storage);
    mount(tab.port);
    expect(container.innerHTML).toBe("");
    act(() => tab.port.reload({ code: "client-protocol", gameId: null }));
    expect(tab.reloads).toHaveLength(1);
    expect(tab.port.state.kind).toBe("navigating");
    expect(container.innerHTML).toBe("");
    /* the only thing written is the port's own marker */
    expect(Array.from(storage.items.keys())).toEqual([CLIENT_UPDATE_STORAGE_KEY]);
  });

  it("the reload did not help: it says so, in plain words, and does not reload again by itself", () => {
    const storage = memoryStorage();
    const before = page(storage);
    before.port.reload({ code: "client-protocol", gameId: null });
    expect(before.reloads).toHaveLength(1);
    /* the reloaded page, with the same tab's storage, is told the same thing */
    const after = page(storage);
    mount(after.port);
    act(() => after.port.reload({ code: "client-protocol", gameId: null }));
    expect(after.reloads).toHaveLength(0);
    expect(notice()).not.toBeNull();
    expect(notice()!.getAttribute("role")).toBe("alertdialog");
    const text = container.textContent ?? "";
    expect(text).toContain("This page is still out of step with the game server");
    expectPlainWords(text);
    /* About the whole page (a connection-level answer): no table is named, and there is no lobby to go back to. */
    expect(text).not.toContain("Nothing in the game has changed.");
    expect(lobbyButton()).toBeNull();
  });

  it("a page with no storage asks at once -- rules wording only when the rules are the reason", () => {
    const rules = page(null);
    mount(rules.port);
    act(() => rules.port.reload({ code: "client-rules", gameId: GAME }));
    expect(rules.reloads).toHaveLength(0);
    let text = container.textContent ?? "";
    expect(text).toContain("This page needs to be reloaded");
    expect(text).toContain("This table plays a version of the rules this page does not have.");
    expectPlainWords(text);

    const protocol = page(null);
    mount(protocol.port);
    act(() => protocol.port.reload({ code: "client-protocol", gameId: null }));
    text = container.textContent ?? "";
    expect(text).toContain("This page and the game server are running different versions of the game.");
    expect(text).not.toMatch(/rules/i);
    expectPlainWords(text);

    /* An announcement the server could not read says exactly that -- not "different versions" (review F6). */
    const announcement = page(null);
    mount(announcement.port);
    act(() => announcement.port.reload({ code: "client-announcement", gameId: null }));
    text = container.textContent ?? "";
    expect(text).toContain("This page could not tell the game server which version of the game it is running.");
    expect(text).not.toMatch(/different versions|rules/i);
    expectPlainWords(text);
  });

  it("an answer about one table offers the way back to the lobby: the tab forgets the table, nothing else is written, and the page reloads", () => {
    const storage = memoryStorage();
    page(storage).port.reload({ code: "client-rules", gameId: GAME });
    const tab = page(storage);
    mount(tab.port);
    act(() => tab.port.reload({ code: "client-rules", gameId: GAME }));
    expect(container.textContent).toContain("Nothing in the game has changed.");
    const lobby = lobbyButton();
    expect(lobby).not.toBeNull();
    expect(lobby!.textContent).toBe("Back to the lobby");
    const markerBefore = storage.items.get(CLIENT_UPDATE_STORAGE_KEY);
    act(() => lobby!.click());
    expect(tab.forgotten).toHaveLength(1);
    expect(tab.reloads).toHaveLength(1);
    expect(storage.items.get(CLIENT_UPDATE_STORAGE_KEY)).toBe(markerBefore);
    expect(container.innerHTML).toBe("");
    /* A route that could not be followed is about the table too. */
    const routed = page(null);
    mount(routed.port);
    act(() => routed.port.routeToBundle({ url: "/v12/", gameId: GAME }));
    expect(container.textContent).toContain("could not move there by itself");
    expect(lobbyButton()).not.toBeNull();
    expectPlainWords(container.textContent ?? "");
  });

  it("a route that could not be followed says 'cannot continue here right now' -- never a loop", () => {
    const storage = memoryStorage();
    for (let hop = 0; hop < MAX_ROUTE_HOPS; hop += 1) {
      const tab = page(storage);
      tab.port.routeToBundle({ url: "/v12/", gameId: GAME });
      expect(tab.assigned).toEqual(["/v12/"]);
    }
    const last = page(storage);
    mount(last.port);
    act(() => last.port.routeToBundle({ url: "/v12/", gameId: GAME }));
    expect(last.assigned).toEqual([]);
    const text = container.textContent ?? "";
    expect(text).toContain("This table cannot continue here right now");
    expectPlainWords(text);
  });

  it("its one button is the player's own reload: it reloads once, and a repeat afterwards still asks", () => {
    const storage = memoryStorage();
    page(storage).port.reload({ code: "client-rules", gameId: GAME });
    const tab = page(storage);
    mount(tab.port);
    act(() => tab.port.reload({ code: "client-rules", gameId: GAME }));
    expect(tab.reloads).toHaveLength(0);
    const button = reloadButton();
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe("Reload");
    act(() => button!.click());
    expect(tab.reloads).toHaveLength(1);
    expect(tab.port.state.kind).toBe("navigating");
    expect(container.innerHTML).toBe("");
    /* after the player's reload, the same answer asks again (the marker was refreshed): still no automatic loop */
    const again = page(storage);
    again.port.reload({ code: "client-rules", gameId: GAME });
    expect(again.reloads).toHaveLength(0);
    expect(again.port.state).toMatchObject({ kind: "needs-reload", repeated: true });
    /* the only thing ever written is the port's own marker */
    expect(Array.from(storage.items.keys())).toEqual([CLIENT_UPDATE_STORAGE_KEY]);
  });

  it("the browser port's way back to the lobby forgets the router's active game AND the table (what the shell's own lobby buttons forget)", () => {
    window.sessionStorage.setItem(ACTIVE_GAME_STORAGE_KEY, JSON.stringify({ gameId: 0, roomId: "offline-sandbox", mode: "sandbox" }));
    window.sessionStorage.setItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY, GAME);
    /* jsdom does not navigate; it says so on the console. */
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      createBrowserClientUpdatePort().backToLobby();
    } finally {
      quiet.mockRestore();
    }
    expect(window.sessionStorage.getItem(ACTIVE_GAME_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(ACTIVE_SANDBOX_ROOM_STORAGE_KEY)).toBeNull();
    expect(window.sessionStorage.getItem(CLIENT_UPDATE_STORAGE_KEY)).toBeNull(); // no marker: nothing else written
  });

  it("is mounted in index.tsx beside the session-ended notice, and the page's port is installed before render", () => {
    const index = readStripped("index.tsx");
    expect(index).toMatch(/<SessionEndedNotice \/>\s*<ClientUpdateNotice \/>/);
    /* the port is installed before the tree renders (anchorIndex throws when either anchor is gone) */
    expect(anchorIndex(index, "installClientUpdatePort(createBrowserClientUpdatePort());")).toBeLessThan(anchorIndex(index, "root.render("));
  });
});
