/** @jest-environment jsdom */
// frontend/src/utils/hostRetry.test.ts
//
// LIVE-2A (LIVE-2 §13.4 step 1): the server no longer lets `host` overwrite a room that exists, so the client's
// Host is a write with an answer -- the room it created, or `room-code-taken` -- and on a taken code it tries a
// fresh one, up to five times. The room the taken code names is never painted as this tab's waiting room.

jest.mock("../config", () => ({ GAME_SERVER_URL: "ws://game.test/gs", CLIENT_BUILD_ID: "dev" }));

import { hostSandboxRoom, HOST_CODE_ATTEMPTS } from "./sandboxRoom";
import { resetRoomDocLinks, setRoomDocSocketFactory, subscribeRoomDoc } from "./roomDocLink";

type Sent = { kind: string; room?: string; claim?: string; write?: { op: string; hostId?: string } };

interface FakeSocket {
  sent: Sent[];
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** A fake server: attempt `n`'s code is taken while `n < free`; the attempt at `free` is hosted. */
function fakeServer(free: number) {
  const sockets: FakeSocket[] = [];
  setRoomDocSocketFactory(() => {
    const attempt = sockets.length;
    const socket: FakeSocket = {
      sent: [],
      send(data) {
        const frame = JSON.parse(data) as Sent;
        this.sent.push(frame);
        const reply = (value: object) => setTimeout(() => socket.onmessage?.({ data: JSON.stringify(value) }), 0);
        if (frame.kind === "room-hello") {
          // A taken code's hello is answered with SOMEBODY ELSE'S room.
          reply({ kind: "room", room: frame.room, doc: attempt < free ? { code: frame.room, hostId: "p-mallory", status: "waiting", players: [{ id: "p-mallory", nickname: "M", isReady: false }], variants: {} } : null });
        }
        if (frame.kind === "room-write" && frame.write?.op === "host") {
          if (attempt < free) reply({ kind: "error", code: "room-code-taken", reason: "That room code is already in use." });
          else reply({ kind: "room", room: frame.room, doc: { code: frame.room, hostId: frame.write.hostId, status: "waiting", players: [{ id: frame.write.hostId, nickname: "Host", isReady: false }], variants: {} } });
        }
      },
      close() {
        setTimeout(() => socket.onclose?.({}), 0);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    sockets.push(socket);
    setTimeout(() => socket.onopen?.(), 0);
    return socket;
  });
  return sockets;
}

afterEach(() => resetRoomDocLinks());

describe("Host tries a fresh code when the one it drew is taken (LIVE-2A)", () => {
  it("retries on room-code-taken and returns the code of the room it actually hosted", async () => {
    const sockets = fakeServer(2);
    const errors: string[] = [];
    const code = await hostSandboxRoom("p-host", "Host");
    expect(sockets).toHaveLength(3);
    const hostedOn = sockets[2].sent.find((frame) => frame.kind === "room-write")?.room;
    expect(code).toBe(hostedOn);
    // The taken codes' rooms were never delivered as this tab's room: a late subscriber to the hosted code sees ours.
    const seen: Array<string | undefined> = [];
    subscribeRoomDoc(code as string, "p-host", (doc) => seen.push(doc?.hostId), (message) => errors.push(message));
    expect(seen).toEqual(["p-host"]);
    expect(errors).toEqual([]);
  });

  it("gives up after five taken codes, with a sentence, and never hands back a room it did not host", async () => {
    const sockets = fakeServer(99);
    await expect(hostSandboxRoom("p-host", "Host")).rejects.toThrow(/free room code/);
    expect(sockets).toHaveLength(HOST_CODE_ATTEMPTS);
    expect(HOST_CODE_ATTEMPTS).toBe(5);
  });

  it("hosts at once when the first code is free", async () => {
    const sockets = fakeServer(0);
    const code = await hostSandboxRoom("p-host", "Host");
    expect(sockets).toHaveLength(1);
    expect(code).toMatch(/^JUNO-[A-Z0-9]{3}$/);
  });
});
