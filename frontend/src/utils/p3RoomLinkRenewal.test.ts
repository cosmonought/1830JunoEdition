/** @jest-environment node */
// frontend/src/utils/p3RoomLinkRenewal.test.ts
//
// PHASE 3 (P3-ACCT), independent review M2 / L1: a sign-in REPLACES the session, and `renewRoomLinks` moves every
// socket of this page onto the new one. Pinned against a fake socket:
//
//   an op SENT on the old socket and unanswered is told the connection was renewed (it may or may not have landed);
//   an op that never left this page (queued for a socket that had not opened) is NOT ambiguous -- it stays queued and
//   goes out on the new socket, and its answer arrives as usual;
//   every renewal is counted and announced (the lobby re-asks what it read on the old session);
//   a renewal while a bootstrap is still on its way never opens a second socket for one channel (the attach race).

jest.mock("../config", () => ({ ...jest.requireActual("../config"), GAME_SERVER_URL: "wss://play.example/gs" }));

import { onRoomLinksRenewed, renewRoomLinks, resetRoomLinks, roomLinkRenewals, roomOp, setRoomSocketFactory, watchRoomLink, type SocketLike } from "./roomLink";
import { installSessionPort, type SessionPort, type SessionState } from "./sessionBootstrap";

interface Fake {
  socket: SocketLike;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  open(): void;
  deliver(frame: unknown): void;
}

let made: Fake[] = [];

beforeEach(() => {
  made = [];
  setRoomSocketFactory(() => {
    const fake: Fake = {
      sent: [],
      closed: false,
      socket: {
        send: (data) => fake.sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => {
          fake.closed = true;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      },
      open: () => fake.socket.onopen?.(),
      deliver: (frame) => fake.socket.onmessage?.({ data: JSON.stringify(frame) }),
    };
    made.push(fake);
    return fake.socket;
  });
});

afterEach(() => {
  resetRoomLinks();
  installSessionPort(null);
});

const flush = async () => {
  for (let n = 0; n < 10; n += 1) await Promise.resolve();
};
const opFrames = (fake: Fake) => fake.sent.filter((frame) => frame.kind === "room-op");

describe("P3-ACCT renewRoomLinks (review M2): only what was SENT is ambiguous", () => {
  it("an op sent on the old socket is told the connection was renewed; the old socket closes and a new one opens", async () => {
    const sent = roomOp({ type: "my-tables" });
    made[0].open();
    expect(opFrames(made[0])).toHaveLength(1);
    renewRoomLinks();
    await expect(sent).resolves.toEqual({ ok: false, code: "unavailable", reason: "The connection to the game server was renewed for your account. Check the table and try again." });
    expect(made[0].closed).toBe(true);
    expect(made).toHaveLength(2);
  });

  it("an op that never left this page stays queued across the renewal and goes out on the NEW socket -- answered as usual", async () => {
    const queued = roomOp({ type: "my-tables" });
    expect(opFrames(made[0])).toHaveLength(0); // the first socket never opened
    renewRoomLinks();
    expect(made).toHaveLength(2);
    made[1].open();
    const [frame] = opFrames(made[1]);
    expect(frame).toMatchObject({ kind: "room-op", op: { type: "my-tables" } });
    expect(opFrames(made[0])).toHaveLength(0);
    made[1].deliver({ kind: "room-ack", requestId: frame.requestId, ok: true, data: { tables: [] } });
    await expect(queued).resolves.toEqual({ ok: true, data: { tables: [] } });
  });

  it("consolidated integration (review): a table's link watchers (the clock chip) hear that the renewed link is down until the new socket opens", async () => {
    const heard: boolean[] = [];
    const stop = watchRoomLink("g_0000000000000000000000000w", (open) => heard.push(open));
    const opened = made[made.length - 1];
    opened.open();
    await flush();
    expect(heard[heard.length - 1]).toBe(true);
    renewRoomLinks();
    expect(heard[heard.length - 1]).toBe(false);
    made[made.length - 1].open();
    await flush();
    expect(heard[heard.length - 1]).toBe(true);
    stop();
  });

  it("every renewal is counted and announced", () => {
    const before = roomLinkRenewals();
    let told = 0;
    const stop = onRoomLinksRenewed(() => (told += 1));
    renewRoomLinks();
    renewRoomLinks();
    stop();
    renewRoomLinks();
    expect(roomLinkRenewals()).toBe(before + 3);
    expect(told).toBe(2);
  });
});

describe("P3-ACCT renewRoomLinks (review L1): never two sockets for one channel", () => {
  it("a renewal while the first bootstrap is still on its way: both answers arrive, ONE socket opens", async () => {
    const answers: Array<(state: SessionState) => void> = [];
    let state: SessionState = "unknown";
    const port: SessionPort = {
      get state() {
        return state;
      },
      refreshable: true,
      endedReason: null,
      account: null,
      ensure: () =>
        new Promise<SessionState>((resolve) =>
          answers.push((next) => {
            state = next;
            resolve(next);
          }),
        ),
      startFresh: async () => "unprofiled",
      subscribe: () => () => undefined,
      api: async () => ({ kind: "unavailable" }),
    };
    installSessionPort(port);
    const pending = roomOp({ type: "my-tables" });
    expect(made).toHaveLength(0); // waiting for the bootstrap
    renewRoomLinks(); // a sign-in landed meanwhile: the channel attaches again, still waiting
    expect(answers).toHaveLength(2);
    answers[0]("ready");
    await flush();
    answers[1]("ready");
    await flush();
    expect(made).toHaveLength(1);
    made[0].open();
    const [frame] = opFrames(made[0]);
    made[0].deliver({ kind: "room-ack", requestId: frame.requestId, ok: true, data: { tables: [] } });
    await expect(pending).resolves.toEqual({ ok: true, data: { tables: [] } });
  });
});
