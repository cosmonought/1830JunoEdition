/** @jest-environment node */
// frontend/src/utils/roomLink.test.ts
//
// LIVE-2D: the room socket, client side, against a fake socket (`setRoomSocketFactory`). What is pinned here:
//   - an op is a `room-op` frame answered by its `room-ack` -- the ack's data on success, the server's code on a
//     refusal, and a refusal the link makes itself when nobody answers (never a hung promise);
//   - `watchRoom` delivers the server's RoomView, and a loss (`not-found` / `gone` / `kicked`, and the 4410 close that
//     follows) is said ONCE and is terminal -- nothing reconnects into a refusal;
//   - one socket per game, however many things listen to it, and one for the lobby;
//   - no frame the client sends names who it is: no claim, no seat, no PIN, no token, no author.

jest.mock("../config", () => ({ ...jest.requireActual("../config"), GAME_SERVER_URL: "wss://play.example/gs" }));

import {
  LOBBY_CHANNEL,
  ROOM_OP_TIMEOUT_MS,
  resetRoomLinks,
  roomLinkAvailable,
  roomOp,
  sendChat,
  sendPresence,
  setRoomSocketFactory,
  subscribeChat,
  subscribePresence,
  watchPublicRooms,
  watchRoom,
  type RoomLoss,
  type SocketLike,
} from "./roomLink";
import { refusalMessage, type RoomSummary, type RoomView } from "./roomProtocol";
import { NO_MONEY_UNDO_POLICY } from "../gameEngine/logRevert";
import { THIS_BUNDLE_ANNOUNCEMENT } from "./clientAnnouncement";

const GAME = "g_0123456789abcdefghjkmnpqr0";
const OTHER = "g_aaaaaaaaaaaaaaaaaaaaaaaaa4";

interface Fake {
  url: string;
  socket: SocketLike;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  open(): void;
  deliver(frame: unknown): void;
  closeWith(code: number): void;
}

let made: Fake[] = [];

beforeEach(() => {
  made = [];
  setRoomSocketFactory((url) => {
    const fake: Fake = {
      url,
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
      closeWith: (code) => fake.socket.onclose?.({ code }),
    };
    made.push(fake);
    return fake.socket;
  });
});

afterEach(() => {
  resetRoomLinks();
  jest.useRealTimers();
});

const flush = async () => {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
};

const view = (over: Partial<RoomView> = {}): RoomView =>
  ({
    gameId: GAME,
    code: "JUNO-7K4M-Q2ZP",
    joinable: true,
    visibility: "public",
    status: "waiting",
    lifecycle: "waiting",
    closed: false,
    held: false,
    hostId: "p-0000000000000000",
    players: [],
    playerCount: null,
    seatCap: 6,
    variants: {},
    createdAtMs: 1,
    undoPolicy: NO_MONEY_UNDO_POLICY,
    you: { role: "viewer", playerId: null, kicked: false, canStart: false },
    ...over,
  }) as RoomView;

const opFrames = (fake: Fake) => fake.sent.filter((frame) => frame.kind === "room-op");

describe("an op is answered by its ack (LIVE-2D)", () => {
  it("`create` rides the lobby channel and resolves with the ack's data", async () => {
    expect(roomLinkAvailable()).toBe(true);
    const answer = roomOp({ type: "create", visibility: "public", exactPlayers: null, variants: {} as never, nickname: "Host" });
    expect(made).toHaveLength(1);
    /* LIVE-4 (L4-3): every socket this bundle opens announces it -- client protocol 1, its rules, its build. */
    expect(made[0].url).toBe(`wss://play.example/gs?${THIS_BUNDLE_ANNOUNCEMENT}`);
    expect(THIS_BUNDLE_ANNOUNCEMENT).toMatch(/^cp=1&cr=11(&cb=[A-Za-z0-9._-]+)?$/);
    // Queued until the socket opens, then sent.
    expect(made[0].sent).toHaveLength(0);
    made[0].open();
    const [frame] = opFrames(made[0]);
    expect(frame).toMatchObject({ kind: "room-op", op: { type: "create", nickname: "Host" } });
    expect(frame).not.toHaveProperty("gameId");
    expect(typeof frame.requestId).toBe("string");
    made[0].deliver({ kind: "room-ack", requestId: frame.requestId, ok: true, data: { gameId: GAME, code: "JUNO-7K4M-Q2ZP", playerId: "p-0000000000000000" } });
    await expect(answer).resolves.toEqual({ ok: true, data: { gameId: GAME, code: "JUNO-7K4M-Q2ZP", playerId: "p-0000000000000000" } });
  });

  it("a refused ack resolves `ok: false` with the server's code -- never a rejection", async () => {
    const answer = roomOp({ type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: true });
    made[0].open();
    const [frame] = opFrames(made[0]);
    made[0].deliver({ kind: "room-ack", requestId: frame.requestId, ok: false, code: "room-full", reason: "That table is full." });
    await expect(answer).resolves.toEqual({ ok: false, code: "room-full", reason: "That table is full." });
  });

  it("an ack for another request settles nothing; each op is settled by its own requestId", async () => {
    const first = roomOp({ type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: false });
    const second = roomOp({ type: "join", code: "JUNO-2346-789A", takeSeat: true });
    made[0].open();
    const [a, b] = opFrames(made[0]);
    expect(a.requestId).not.toBe(b.requestId);
    made[0].deliver({ kind: "room-ack", requestId: b.requestId, ok: true, data: { gameId: OTHER } });
    made[0].deliver({ kind: "room-ack", requestId: "r-nobody", ok: true, data: { gameId: "g_nobody" } });
    made[0].deliver({ kind: "room-ack", requestId: a.requestId, ok: false, code: "invalid-or-expired", reason: "x" });
    await expect(second).resolves.toEqual({ ok: true, data: { gameId: OTHER } });
    await expect(first).resolves.toMatchObject({ ok: false, code: "invalid-or-expired" });
  });

  it("no answer is a timeout-style refusal the player can read, not a promise that never settles", async () => {
    jest.useFakeTimers();
    const answer = roomOp({ type: "set-ready", ready: true }, GAME);
    made[0].open();
    jest.advanceTimersByTime(ROOM_OP_TIMEOUT_MS - 1);
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    const result = await answer;
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(refusalMessage((result as { code: string }).code, (result as { reason: string }).reason)).toBe(
      "The game server did not answer. Check the connection and try again.",
    );
  });

  it("an op in flight when the wire drops is told the connection went -- never that it failed", async () => {
    jest.useFakeTimers();
    const answer = roomOp({ type: "take-seat" }, GAME);
    made[0].open();
    made[0].closeWith(1006);
    await expect(answer).resolves.toMatchObject({ ok: false, code: "unavailable" });
  });

  it("every op on a game names that game and nothing about who is asking", () => {
    void roomOp({ type: "kick", playerId: "p-1111111111111111" }, GAME);
    void roomOp({ type: "set-profile", nickname: "Ada", color: null }, GAME);
    void roomOp({ type: "start-game" }, GAME);
    made[0].open();
    const ops = opFrames(made[0]);
    expect(ops.map((frame) => (frame.op as { type: string }).type)).toEqual(["kick", "set-profile", "start-game"]);
    for (const frame of ops) {
      expect(frame.gameId).toBe(GAME);
      expect(Object.keys(frame).sort()).toEqual(["gameId", "kind", "op", "requestId"]);
      for (const field of ["claim", "actor", "author", "pin", "token", "room"]) expect(frame).not.toHaveProperty(field);
    }
  });
});

describe("an op the player was told failed is never sent later (LIVE-2D review)", () => {
  it("a create queued behind a socket that never opened is withdrawn with its `unavailable` answer", async () => {
    jest.useFakeTimers();
    const answer = roomOp({ type: "create", visibility: "public", exactPlayers: null, variants: {} as never, nickname: "Host" });
    made[0].closeWith(1006); // the open failed: the op never reached a socket
    await expect(answer).resolves.toMatchObject({ ok: false, code: "unavailable" });
    jest.advanceTimersByTime(60_000); // the lobby channel reconnects only if somebody still listens
    for (const fake of made) {
      fake.open();
      expect(opFrames(fake)).toEqual([]); // no second table behind the player's back
    }
  });

  it("an op that timed out before the socket opened is withdrawn too", async () => {
    jest.useFakeTimers();
    const answer = roomOp({ type: "kick", playerId: "p-0000000000000001" }, GAME);
    jest.advanceTimersByTime(ROOM_OP_TIMEOUT_MS);
    await expect(answer).resolves.toMatchObject({ ok: false, code: "timeout" });
    made[0].open();
    expect(opFrames(made[0])).toEqual([]);
  });

  it("a table this tab lost is readable again once a join admits it (the seat is not invisible)", async () => {
    const lost: RoomLoss[] = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => lost.push(loss) });
    made[0].open();
    made[0].deliver({ kind: "error", code: "not-found", reason: "There is no such game." });
    made[0].closeWith(4410);
    expect(lost).toHaveLength(1);
    const join = roomOp({ type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: true });
    const lobby = made[made.length - 1];
    lobby.open();
    const [frame] = opFrames(lobby);
    lobby.deliver({ kind: "room-ack", requestId: frame.requestId, ok: true, data: { gameId: GAME, playerId: "p-0000000000000002" } });
    await expect(join).resolves.toMatchObject({ ok: true });
    const views: RoomView[] = [];
    const again: RoomLoss[] = [];
    watchRoom(GAME, { onView: (v) => views.push(v), onLost: (loss) => again.push(loss) });
    expect(again).toEqual([]);
    const game = made[made.length - 1];
    game.open();
    expect(game.sent).toContainEqual({ kind: "room-hello", gameId: GAME });
    game.deliver({ kind: "room", gameId: GAME, view: view({ you: { role: "player", playerId: "p-0000000000000002", kicked: false, canStart: false } }) });
    expect(views.map((v) => v.you.role)).toEqual(["player"]);
  });

  it("a standing room-hello is not said again on every chat line or remount", () => {
    watchRoom(GAME, { onView: () => undefined });
    made[0].open();
    subscribeChat(GAME, () => undefined);
    sendChat(GAME, "one");
    sendChat(GAME, "two");
    expect(made[0].sent.filter((frame) => frame.kind === "room-hello")).toHaveLength(1);
    expect(made[0].sent.filter((frame) => frame.kind === "chat-send")).toHaveLength(2);
  });
});

describe("watchRoom delivers the server's view, and a loss is terminal", () => {
  it("says room-hello once it is open, and hands every view to the listener; a late subscriber gets the last one", () => {
    const views: RoomView[] = [];
    watchRoom(GAME, { onView: (next) => views.push(next) });
    made[0].open();
    expect(made[0].sent).toEqual([{ kind: "room-hello", gameId: GAME }]);
    made[0].deliver({ kind: "room", gameId: GAME, view: view() });
    // A view for another game is not this channel's news.
    made[0].deliver({ kind: "room", gameId: OTHER, view: view({ gameId: OTHER }) });
    made[0].deliver({ kind: "room", gameId: GAME, view: view({ you: { role: "player", playerId: "p-2222222222222222", kicked: false, canStart: false } }) });
    expect(views.map((next) => next.you.role)).toEqual(["viewer", "player"]);
    const late: RoomView[] = [];
    watchRoom(GAME, { onView: (next) => late.push(next) });
    expect(late.map((next) => next.you.playerId)).toEqual(["p-2222222222222222"]);
    expect(made).toHaveLength(1);
  });

  it("an error frame that takes access away calls onLost once -- and the 4410 close after it does not say it twice", async () => {
    const lost: RoomLoss[] = [];
    const errors: string[] = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => lost.push(loss), onError: (code) => errors.push(code) });
    made[0].open();
    made[0].deliver({ kind: "error", code: "kicked", reason: "The host removed you from that table." });
    made[0].closeWith(4410);
    expect(lost).toEqual([{ code: "kicked", reason: "The host removed you from that table." }]);
    expect(errors).toEqual([]);
    expect(made[0].closed).toBe(true);
    // Nothing reconnects into a refusal, and a later subscription is told at once, without asking the server again.
    jest.useFakeTimers();
    jest.advanceTimersByTime(60_000);
    expect(made).toHaveLength(1);
    const again: RoomLoss[] = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => again.push(loss) });
    expect(again).toEqual([{ code: "kicked", reason: "The host removed you from that table." }]);
    await expect(roomOp({ type: "take-seat" }, GAME)).resolves.toEqual({ ok: false, code: "kicked", reason: "The host removed you from that table." });
    expect(made).toHaveLength(1);
  });

  it("a bare 4410 close is a loss too (`not-found`), with a sentence that names no reference", () => {
    const lost: RoomLoss[] = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => lost.push(loss) });
    made[0].open();
    made[0].closeWith(4410);
    expect(lost).toEqual([{ code: "not-found", reason: "You no longer have access to that table." }]);
  });

  it("an error that is not about access goes to onError and the channel keeps its view", () => {
    const lost: RoomLoss[] = [];
    const errors: Array<[string, string]> = [];
    watchRoom(GAME, { onView: () => undefined, onLost: (loss) => lost.push(loss), onError: (code, reason) => errors.push([code, reason]) });
    made[0].open();
    made[0].deliver({ kind: "error", code: "rate-limited", reason: "Slow down." });
    expect(errors).toEqual([["rate-limited", "Slow down."]]);
    expect(lost).toEqual([]);
    expect(made[0].closed).toBe(false);
  });

  it("an ordinary drop reconnects and re-states the standing room-hello", () => {
    jest.useFakeTimers();
    watchRoom(GAME, { onView: () => undefined });
    made[0].open();
    made[0].closeWith(1006);
    jest.advanceTimersByTime(1_000);
    expect(made).toHaveLength(2);
    made[1].open();
    expect(made[1].sent).toEqual([{ kind: "room-hello", gameId: GAME }]);
  });
});

describe("one socket per game, and one for the lobby", () => {
  it("the view, the transcript, presence and ops for one game share one socket and one room-hello", () => {
    watchRoom(GAME, { onView: () => undefined });
    subscribeChat(GAME, () => undefined);
    subscribePresence(GAME, () => undefined);
    void roomOp({ type: "set-ready", ready: true }, GAME);
    sendChat(GAME, "hello table");
    sendPresence(GAME, null);
    expect(made).toHaveLength(1);
    made[0].open();
    const hellos = made[0].sent.filter((frame) => frame.kind === "room-hello");
    expect(hellos).toEqual([{ kind: "room-hello", gameId: GAME }]);
    /* The server signs a chat line with this principal's seat; the frame carries neither author nor name. */
    expect(made[0].sent.find((frame) => frame.kind === "chat-send")).toEqual({ kind: "chat-send", gameId: GAME, text: "hello table" });
    /* The server stamps the seat and the clock on a presence hint; `null` clears this connection's own. */
    expect(made[0].sent.find((frame) => frame.kind === "presence-set")).toEqual({ kind: "presence-set", gameId: GAME, state: null });
  });

  it("a second game is a second socket, and the public list rides the lobby's", () => {
    const lists: RoomSummary[][] = [];
    watchRoom(GAME, { onView: () => undefined });
    watchRoom(OTHER, { onView: () => undefined });
    watchPublicRooms((rooms) => lists.push(rooms));
    expect(made).toHaveLength(3);
    made.forEach((fake) => fake.open());
    expect(made[0].sent).toEqual([{ kind: "room-hello", gameId: GAME }]);
    expect(made[1].sent).toEqual([{ kind: "room-hello", gameId: OTHER }]);
    expect(made[2].sent).toEqual([{ kind: "rooms-watch", on: true }]);
    made[2].deliver({ kind: "rooms", rooms: [{ gameId: GAME, code: "JUNO-7K4M-Q2ZP" }] });
    expect(lists).toEqual([[{ gameId: GAME, code: "JUNO-7K4M-Q2ZP" }]]);
    expect(LOBBY_CHANNEL).toBe("~lobby");
  });

  it("chat and presence for a lost game send nothing and open nothing", () => {
    watchRoom(GAME, { onView: () => undefined });
    made[0].open();
    made[0].deliver({ kind: "error", code: "gone", reason: "closed" });
    sendChat(GAME, "anyone?");
    sendPresence(GAME, null);
    expect(subscribeChat(GAME, () => undefined)).toEqual(expect.any(Function));
    expect(made).toHaveLength(1);
    expect(made[0].sent.filter((frame) => frame.kind !== "room-hello")).toEqual([]);
  });
});
