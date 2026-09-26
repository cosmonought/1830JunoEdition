/** @jest-environment node */
// frontend/src/utils/hostRetry.test.ts
//
// LIVE-2A had the client mint a `JUNO-XXX` code and retry on `room-code-taken`, up to five times. LIVE-2D DELETES
// THE RETRY WITH THE CODE: the server mints the game id, the `JUNO-XXXX-XXXX` invite and the host's seat in one
// `room-op create`, so there is nothing for a client to collide on and nothing to retry. What this file pins now:
// Host is exactly one op; its answer is the server's `{gameId, code, playerId}`; a refusal is the server's code,
// said once, with no second attempt; and the terms the host chose travel as asked -- the server, not the client,
// decides whether a stake is allowed.

jest.mock("../config", () => ({ ...jest.requireActual("../config"), GAME_SERVER_URL: "wss://play.example/gs" }));

import * as fs from "fs";
import * as path from "path";

import { createHostedGame, gameIdOf, joinHostedGame } from "./sandboxRoom";
import { resetRoomLinks, setRoomSocketFactory, type SocketLike } from "./roomLink";
import { refusalMessage } from "./roomProtocol";
import { STANDARD_VARIANTS } from "../gameEngine/gameVariants";

const GAME = "g_0123456789abcdefghjkmnpqr0";

type Frame = { kind: string; requestId?: string; gameId?: string; op?: Record<string, unknown> };

/** A fake server answering each op with `answer(op)`. */
function fakeServer(answer: (op: Record<string, unknown>) => object) {
  const sockets: Array<{ sent: Frame[] }> = [];
  setRoomSocketFactory(() => {
    const record = { sent: [] as Frame[] };
    const socket: SocketLike = {
      send(data) {
        const frame = JSON.parse(data) as Frame;
        record.sent.push(frame);
        if (frame.kind === "room-op" && frame.op) {
          const reply = { kind: "room-ack", requestId: frame.requestId, ...answer(frame.op) };
          setTimeout(() => socket.onmessage?.({ data: JSON.stringify(reply) }), 0);
        }
      },
      close: () => undefined,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    sockets.push(record);
    setTimeout(() => socket.onopen?.(), 0);
    return socket;
  });
  return sockets;
}

const ops = (sockets: Array<{ sent: Frame[] }>) => sockets.flatMap((socket) => socket.sent.filter((frame) => frame.kind === "room-op"));

afterEach(() => resetRoomLinks());

describe("Host is one create op, and the server mints the table (LIVE-2D)", () => {
  it("sends one `create` on the lobby channel and returns the server's game id, code and seat", async () => {
    const sockets = fakeServer(() => ({ ok: true, data: { gameId: GAME, code: "JUNO-7K4M-Q2ZP", playerId: "p-0000000000000000" } }));
    const answer = await createHostedGame(STANDARD_VARIANTS, { visibility: "private", playerCount: 4, anteUjuno: "0" }, "Ada");
    expect(answer).toEqual({ ok: true, data: { gameId: GAME, code: "JUNO-7K4M-Q2ZP", playerId: "p-0000000000000000" } });
    expect(gameIdOf(answer)).toBe(GAME);
    expect(sockets).toHaveLength(1);
    const sent = ops(sockets);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("gameId"); // no game exists yet: the lobby channel carries it
    expect(sent[0].op).toMatchObject({ type: "create", visibility: "private", exactPlayers: 4, nickname: "Ada" });
    /* No code, no id, no seat and no stake of "0": the server mints the first three and a no-money table has no stake. */
    for (const field of ["code", "gameId", "playerId", "hostId", "stake", "claim"]) expect(sent[0].op).not.toHaveProperty(field);
    /* The rules revision is the server's to stamp, never the client's to name. */
    expect(sent[0].op?.variants).not.toHaveProperty("rules");
  });

  it("a refusal is said once, in words, and is never retried", async () => {
    const sockets = fakeServer(() => ({ ok: false, code: "limit-reached", reason: "You already have 3 open tables." }));
    const answer = await createHostedGame(STANDARD_VARIANTS);
    expect(answer).toEqual({ ok: false, code: "limit-reached", reason: "You already have 3 open tables." });
    expect(gameIdOf(answer)).toBeNull();
    expect(ops(sockets)).toHaveLength(1);
    expect(refusalMessage("limit-reached", "You already have 3 open tables.")).toBe("You already have 3 open tables.");
  });

  it("a stake is sent as asked; the server refuses it (`money-games-disabled`) -- the client never decides that", async () => {
    const sockets = fakeServer((op) => (op.stake ? { ok: false, code: "money-games-disabled", reason: "no stakes" } : { ok: true, data: { gameId: GAME } }));
    const staked = await createHostedGame(STANDARD_VARIANTS, { visibility: "public", playerCount: null, anteUjuno: "5000000" });
    expect(ops(sockets)[0].op).toMatchObject({ type: "create", stake: "5000000", exactPlayers: null });
    expect(staked).toMatchObject({ ok: false, code: "money-games-disabled" });
    expect(refusalMessage("money-games-disabled", "no stakes")).toBe("Games with stakes are not open on this server.");
  });

  it("an ok answer without a game id is not a table", () => {
    expect(gameIdOf({ ok: true, data: {} })).toBeNull();
    expect(gameIdOf({ ok: true, data: { gameId: 7 } })).toBeNull();
  });

  it("Join sends the code and whether a seat is wanted -- nothing about who is asking", async () => {
    const sockets = fakeServer(() => ({ ok: true, data: { gameId: GAME, playerId: null, code: "JUNO-7K4M-Q2ZP" } }));
    const answer = await joinHostedGame("JUNO-7K4M-Q2ZP", false);
    expect(gameIdOf(answer)).toBe(GAME);
    expect(ops(sockets)[0].op).toEqual({ type: "join", code: "JUNO-7K4M-Q2ZP", takeSeat: false });
  });

  it("the client mints no code and runs no retry loop any more", () => {
    const text = fs.readFileSync(path.join(__dirname, "sandboxRoom.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const gone of ["HOST_CODE_ATTEMPTS", "room-code-taken", "generateRoomCode", "Math.random", "hostSandboxRoom"]) {
      expect([gone, text.includes(gone)]).toEqual([gone, false]);
    }
  });
});
