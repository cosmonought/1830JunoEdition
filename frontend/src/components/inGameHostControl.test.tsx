/** @jest-environment jsdom */
//
// LIVE-2E: THE IN-GAME "HOST ⇄" CONTROL. LIVE-2D found `transfer-host` server-reachable during an active game with no
// control once the board was up. Pinned here: only the host of an ACTIVE game sees it; it names only other seated
// players; it asks twice; and it sends exactly the named op's target (the server remains the authority). The App
// wires it to the same `transfer-host` room-op the waiting room uses.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { InGameHostControl } from "./InGameHostControl";
import type { RoomView } from "../utils/roomProtocol";
import { NO_MONEY_UNDO_POLICY } from "../gameEngine/logRevert";
import { readShell } from "../utils/sourceScan";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
global.IS_REACT_ACT_ENVIRONMENT = true;

const HOST = "p-0000000000000001";
const GUEST = "p-0000000000000002";

const view = (over: Partial<RoomView> = {}, you: Partial<RoomView["you"]> = {}): RoomView =>
  ({
    gameId: "g_0123456789abcdefghjkmnpqr0",
    code: "JUNO-7K4M-Q2ZP",
    joinable: false,
    visibility: "public",
    status: "playing",
    lifecycle: "active",
    closed: false,
    held: false,
    hostId: HOST,
    players: [
      { id: HOST, nickname: "Ann", isReady: true, online: true },
      { id: GUEST, nickname: "Bo", isReady: true, online: true },
    ],
    playerCount: null,
    seatCap: 6,
    variants: {},
    createdAtMs: 1,
    undoPolicy: NO_MONEY_UNDO_POLICY,
    you: { role: "host", playerId: HOST, kicked: false, canStart: false, ...you },
    ...over,
  }) as RoomView;

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

const render = (element: React.ReactElement) => act(() => root.render(element));
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const click = (element: Element | null) => act(() => (element as HTMLElement).click());

describe("in-game host transfer (LIVE-2E)", () => {
  it("the host of an active game can hand the role to another seated player, asked twice", () => {
    const sent: string[] = [];
    render(<InGameHostControl room={view()} busy={false} onTransferHost={(id) => sent.push(id)} />);
    click(byTestId("ingame-host-open"));
    expect(byTestId(`ingame-host-pick-${HOST}`)).toBeNull(); // never the host themself
    click(byTestId(`ingame-host-pick-${GUEST}`));
    expect(container.textContent).toContain("Make Bo the host?");
    expect(sent).toEqual([]);
    click(byTestId("ingame-host-confirm"));
    expect(sent).toEqual([GUEST]);
  });

  it("is not shown to a player, a watcher, a waiting room (it has its own) or a finished game", () => {
    for (const room of [
      view({}, { role: "player", playerId: GUEST }),
      view({}, { role: "viewer", playerId: null }),
      view({ lifecycle: "waiting", status: "waiting" }),
      view({ lifecycle: "completed" }),
      null,
    ]) {
      render(<InGameHostControl room={room} busy={false} onTransferHost={() => undefined} />);
      expect(byTestId("ingame-host-control")).toBeNull();
    }
  });

  it("is disabled while a room op is in flight", () => {
    render(<InGameHostControl room={view()} busy onTransferHost={() => undefined} />);
    expect(byTestId("ingame-host-open")?.disabled).toBe(true);
  });

  it("the shell mounts it with the same transfer-host op the waiting room uses", () => {
    const app = readShell();
    expect(app).toMatch(/<InGameHostControl room=\{sandboxRoom\} busy=\{sandboxRoomBusy\} onTransferHost=\{handleTransferHost\} \/>/);
    expect(app).toMatch(/const handleTransferHost = useCallback\(\(toPlayerId: string\) => void runRoomOp\(\{ type: "transfer-host", toPlayerId \}\)/);
  });
});
