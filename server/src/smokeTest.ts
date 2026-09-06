// server/src/smokeTest.ts
//
// Two clients, one room, real sockets. Proves the loop end to end.
//
// ==================================================================
//  DESIGN NOTE 1210: THE THING THE UNIT TESTS CANNOT SAY
// ==================================================================
//
// `roomSession.test.ts` proves the loop's decisions and `replayJuno3XD.test.ts` proves the reducer. Neither
// says a byte about whether a real socket carries a real frame to a real room and comes back. That gap is
// exactly where a cutover goes wrong -- and writing a browser client against an unproven server is how the
// gap gets discovered from inside `App.tsx`, which is the one place this project cannot debug cheaply.
//
// SO THIS RUNS FIRST. It is small on purpose: connect, deal, act, watch the other client hear about it, and
// check that an out-of-turn move is refused over the wire rather than only in a unit test.
//
// Usage: node server/dist/server/src/smokeTest.js

import { WebSocket } from "ws";

import { createGameServer, trustClaimedIdentity } from "./gameServer";

const PORT = 8917;
const BUILD = "smoke-build";
const ALICE = "p-alice";
const BOB = "p-bob";

interface Frame {
  kind: string;
  [key: string]: unknown;
}

/** A tiny client: connects, records every frame, and lets the script await the next one. */
function connect(claim: string, room: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Frame>;
  send: (frame: unknown) => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const queue: Frame[] = [];
    let waiting: ((frame: Frame) => void) | null = null;

    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (waiting) {
        const resolveWith = waiting;
        waiting = null;
        resolveWith(frame);
      } else {
        queue.push(frame);
      }
    });
    socket.on("error", reject);
    socket.on("open", () => {
      socket.send(JSON.stringify({ kind: "hello", room, build: BUILD, claim, baseIndex: -1 }));
      resolve({
        socket,
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: () =>
          new Promise<Frame>((res) => {
            const queued = queue.shift();
            if (queued) res(queued);
            else waiting = res;
          }),
      });
    });
  });
}

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    // eslint-disable-next-line no-console
    console.log(`  ok  ${label}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`  FAIL ${label}`, detail ?? "");
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const server = createGameServer({
    port: PORT,
    build: BUILD,
    resolveIdentity: trustClaimedIdentity,
  });

  const alice = await connect(ALICE, "SMOKE");
  const bob = await connect(BOB, "SMOKE");

  // Both joins are answered with a catch-up, which for an empty room is an empty log.
  const aliceHello = await alice.next();
  const bobHello = await bob.next();
  check("a joining client is caught up", aliceHello.kind === "catch-up", aliceHello);
  check("so is the second one", bobHello.kind === "catch-up", bobHello);

  // Alice deals the game.
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: -1,
    submissionId: "setup-1",
    msg: {
      SetupGame: {
        players: [
          { id: ALICE, nickname: "Alice" },
          { id: BOB, nickname: "Bob" },
        ],
        variants: {},
      },
    },
  });

  const applied = await alice.next();
  check("the deal is applied", applied.kind === "applied", applied);
  check(
    "and carries the entry it appended",
    Array.isArray(applied.entries) && (applied.entries as unknown[]).length === 1,
    applied.entries,
  );
  check("with a digest", typeof applied.digest === "string" && applied.digest.length === 16);

  // Bob hears about it without having asked.
  const heard = await bob.next();
  check("the other client is told", heard.kind === "applied", heard);
  check(
    "and is given the same entries to apply itself",
    JSON.stringify(heard.entries) === JSON.stringify(applied.entries),
  );

  // A retry of the same submission must not deal twice.
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: -1,
    submissionId: "setup-1",
    msg: { OpenStockRound: {} },
  });
  const retry = await alice.next();
  check("a repeated submission id is answered with a catch-up", retry.kind === "catch-up", retry);
  check(
    "and the room did not grow",
    Array.isArray(retry.entries) && (retry.entries as unknown[]).length === 1,
    retry.entries,
  );

  // Open the stock round so there is a turn to be out of.
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 0,
    submissionId: "open-1",
    msg: { OpenStockRound: {} },
  });
  check("the stock round opens", (await alice.next()).kind === "applied");
  await bob.next(); // Bob's copy of the same news.

  // Bob is not on turn, and the wire says so.
  bob.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 1,
    submissionId: "bob-1",
    msg: { PassTurn: { game_id: 0 } },
  });
  const refused = await bob.next();
  check("an out-of-turn move is refused over the wire", refused.kind === "refused", refused);
  check("with the reason a player can read", refused.reason === "It is not your turn.", refused);

  // A stale build is turned away before anything is judged.
  alice.send({
    kind: "submit",
    build: "some-other-build",
    baseIndex: 1,
    msg: { PassTurn: { game_id: 0 } },
  });
  const skew = await alice.next();
  check("a mismatched build is named rather than applied", skew.kind === "build-skew", skew);

  alice.socket.close();
  bob.socket.close();
  await server.close();

  // eslint-disable-next-line no-console
  console.log(process.exitCode === 1 ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

void main();
