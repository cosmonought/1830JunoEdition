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

import type { Server as HttpServer } from "http";

import { WebSocket } from "ws";

import { createGameServer, trustClaimedIdentity } from "./gameServer";

/* ==================================================================
    A PORT THE OPERATING SYSTEM CHOOSES, AND WHY IT IS NOT 8917
   ==================================================================
   THIS TEST IS MEANT TO BE RUNNABLE WHILE THE REAL SERVER IS UP. It is the first thing to reach for when the
   browser is misbehaving, and that is precisely the moment when 8917 is already taken -- so a fixed port
   would make the check unavailable exactly when it is wanted, and the failure (`EADDRINUSE`) looks like a
   fault in the thing being diagnosed rather than in the diagnosis. Port 0 asks the OS for a free one. */
let port = 0;

const listeningPort = (http: HttpServer): Promise<number> =>
  new Promise((resolve) => {
    const read = () => {
      const address = http.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    if (http.listening) read();
    else http.once("listening", read);
  });

const BUILD = "smoke-build";
const ALICE = "p-alice";
const BOB = "p-bob";
const CAROL = "p-carol";

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
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
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
          withTimeout(
            new Promise<Frame>((res) => {
              const queued = queue.shift();
              if (queued) res(queued);
              else waiting = res;
            }),
            `a frame for ${claim} in ${room}`,
          ),
      });
    });
  });
}

/** The same tiny client, speaking the waiting room's protocol instead of the log's (#1215). */
function connectRoom(claim: string, room: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Frame>;
  write: (write: unknown) => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
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
      socket.send(JSON.stringify({ kind: "room-hello", room, build: BUILD, claim }));
      resolve({
        socket,
        write: (write) => socket.send(JSON.stringify({ kind: "room-write", room, write })),
        next: () =>
          withTimeout(
            new Promise<Frame>((res) => {
              const queued = queue.shift();
              if (queued) res(queued);
              else waiting = res;
            }),
            `a frame for ${claim} in ${room}`,
          ),
      });
    });
  });
}

/** A frame that never arrives must FAIL, not hang.
 *
 *  A harness that waits forever tells you nothing and costs whoever ran it several minutes before they think
 *  to kill it. Every `next()` below is a claim that a frame is owed; this is what makes a wrong claim say so. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000),
    ),
  ]);
}

const roster = (frame: Frame): { id: string; nickname: string }[] =>
  ((frame.doc as { players?: { id: string; nickname: string }[] } | null)?.players ?? []);

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
    port: 0,
    build: BUILD,
    resolveIdentity: trustClaimedIdentity,
  });
  port = await listeningPort(server.http);

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
  /* #1223: a WATCHER's frame carries a real digest, not the empty string the borrowed one fell back to.
     Without this the divergence alarm is unavailable to every client that is not the one acting -- which is
     most of them, most of the time, and exactly the population a silent drift hides in. */
  check(
    "and a digest it can actually check itself against",
    typeof heard.digest === "string" && heard.digest.length === 16 && heard.digest === applied.digest,
    heard.digest,
  );
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

  /* ---- #1219: TWO CLIENTS, THE SAME NONCE ----
     THIS IS THE CHECK THE HAND-WRITTEN IDS ABOVE WERE HIDING. `setup-1`, `open-1`, `bob-1` -- every one
     distinct, because a person naming them makes them distinct without thinking about it. The real client
     mints a counter per connection, so in a room of two the SECOND player's first move carries the same
     string as the FIRST player's first move, and the duplicate guard answered it as a move already made.
     Every button did nothing.
     THE ID BELOW IS DELIBERATELY THE ONE ALICE ALREADY USED. It must still be applied, because it is a
     different player: the registry is keyed by (actor, nonce) and not by the nonce alone. */
  /* Alice opens the bidding, which is what puts BOB on turn -- the collision below has to be tested with a
     move its sender is actually allowed to make, or a refusal would mask the very thing being checked. */
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 0,
    submissionId: "alice-bid",
    msg: { WaterfallBidHigher: { game_id: 0, private_id: 6, bid_amount: "225" } },
  });
  check("the opening bid is applied", (await alice.next()).kind === "applied");
  await bob.next();

  bob.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 1,
    submissionId: "setup-1",
    msg: { WaterfallBidHigher: { game_id: 0, private_id: 3, bid_amount: "75" } },
  });
  const bobsCollision = await bob.next();
  check(
    "one player's nonce does not answer for another's (#1219)",
    bobsCollision.kind === "applied",
    bobsCollision,
  );
  await alice.next(); // Alice's copy of the same news.

  /* #1249: THE ROOM MESSAGES HAVE OWNERS NOW. This used to open the Stock Round here, mid-auction, "so there
     is a turn to be out of" -- and the server let it, because #1220 exempted the whole family from every
     check. The auction has six privates still for sale, so the board says no; the turn to be out of is the
     auction's own (Bob bid last, so Alice is on turn). */
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 2,
    submissionId: "open-1",
    msg: { OpenStockRound: {} },
  });
  const early = await alice.next();
  check("the stock round cannot be opened mid-auction (#1249)", early.kind === "refused", early);
  check(
    "and the refusal says why",
    typeof early.reason === "string" && early.reason.startsWith("The auction is not over yet"),
    early,
  );

  // Bob is not on turn, and the wire says so.
  bob.send({
    kind: "submit",
    build: BUILD,
    baseIndex: 2,
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
    baseIndex: 2,
    msg: { PassTurn: { game_id: 0 } },
  });
  const skew = await alice.next();
  check("a mismatched build is named rather than applied", skew.kind === "build-skew", skew);

  /* ---- THE WAITING ROOM (#1215) ----
     This is the half that was on Firestore until it went unreachable and the table could not be seated at
     all. Two clients, one room code, and the question is whether each sees the other BEFORE the deal --
     because the Start button is gated on the roster and `toSetupPlayers` reads it to build the game. */
  const hostRoom = await connectRoom(ALICE, "LOBBY");

  /* ---- #1216: HELLO AND THE FIRST WRITE, BACK TO BACK ----
     THE ORIGINAL VERSION OF THIS CHECK AWAITED THE HELLO'S REPLY BEFORE WRITING, and that politeness is what
     let a broken build reach a browser. The client does not wait: `hostSandboxRoom` calls `writeRoomDoc`,
     which opens the socket and queues the write, and both frames go out the instant it opens. Sending them
     in that order HERE is the whole point of this check -- it fails against a server whose handler yields
     between them, which is exactly what happened. */
  hostRoom.write({ op: "host", hostId: ALICE, nickname: "Alice", variants: {} });

  const emptyForHost = await hostRoom.next();
  check("an unhosted room is empty rather than absent", emptyForHost.doc === null, emptyForHost);

  const hosted = await hostRoom.next();
  check(
    "a write sent before the hello is answered still lands (#1216)",
    roster(hosted).length === 1,
    hosted,
  );

  const joinRoom = await connectRoom(BOB, "LOBBY");
  const joinerFirst = await joinRoom.next();
  check("a joiner's first frame carries the room that already exists", roster(joinerFirst).length === 1);

  // A write to a room nobody hosted is dropped: a room whose host was whoever wrote first would hand out
  // the Start button by accident.
  const orphan = await connectRoom(CAROL, "NOBODY");
  orphan.write({ op: "upsert-player", player: { id: CAROL, nickname: "Carol", isReady: false } });
  await orphan.next();
  check("a write to an unhosted room does not invent one", (await orphan.next()).doc === null);
  orphan.socket.close();

  joinRoom.write({ op: "upsert-player", player: { id: BOB, nickname: "Bob", isReady: false } });
  const seated = await joinRoom.next();
  check("a joiner appears in the roster", roster(seated).length === 2, seated);
  check(
    "and the HOST sees them, which is the failure #856 was about",
    roster(await hostRoom.next()).length === 2,
  );

  // #541: renaming must not move a player to the back of the table -- `toSetupPlayers` reads this order.
  hostRoom.write({ op: "upsert-player", player: { id: ALICE, nickname: "Renamed", isReady: true } });
  const renamed = await hostRoom.next();
  check(
    "a rename updates in place and does not reorder the table",
    roster(renamed)[0]?.id === ALICE && roster(renamed)[0]?.nickname === "Renamed",
    renamed,
  );
  await joinRoom.next();

  hostRoom.socket.close();
  joinRoom.socket.close();
  alice.socket.close();
  bob.socket.close();
  await server.close();

  await durableLog();

  // eslint-disable-next-line no-console
  console.log(process.exitCode === 1 ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

/* ==================================================================
    #1250: THE ROOM SURVIVES THE PROCESS
   ==================================================================
   A second server with a file store, a deal and a move, then the process "dies" (the server is closed) and
   a third server opens on the same directory. The check is that the third one already knows the game: the
   joining client's catch-up carries both entries, with the ids the first process minted, and the room
   document still names the host. And the ids a restarted process mints must not collide with the stored
   ones -- `effectiveActions` kills reverted entries by id (#1026), so a collision would be a revert aimed at
   the wrong move. */
async function durableLog(): Promise<void> {
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const pathModule = require("path") as typeof import("path");
  const { createFileLogStore } = require("./fileLogStore") as typeof import("./fileLogStore");

  const directory = fs.mkdtempSync(pathModule.join(os.tmpdir(), "1830-smoke-"));

  const first = createGameServer({
    port: 0,
    build: BUILD,
    resolveIdentity: trustClaimedIdentity,
    store: createFileLogStore(directory),
  });
  port = await listeningPort(first.http);

  const lobby = await connectRoom(ALICE, "DURABLE");
  lobby.write({ op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
  await lobby.next();
  await lobby.next();

  const alice = await connect(ALICE, "DURABLE");
  await alice.next();
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: -1,
    submissionId: "deal",
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
  const dealt = await alice.next();
  check("a stored room applies the deal", dealt.kind === "applied", dealt);
  const storedIds = (dealt.entries as { id: string }[]).map((entry) => entry.id);

  alice.socket.close();
  lobby.socket.close();
  await first.close();

  const file = pathModule.join(directory, "DURABLE.log.jsonl");
  check("the log is on disk, one line per entry", fs.readFileSync(file, "utf8").trim().split("\n").length === 1);

  const second = createGameServer({
    port: 0,
    build: BUILD,
    resolveIdentity: trustClaimedIdentity,
    store: createFileLogStore(directory),
  });
  port = await listeningPort(second.http);

  const rejoined = await connectRoom(BOB, "DURABLE");
  const doc = await rejoined.next();
  check(
    "the room document survives the restart, host and all",
    (doc.doc as { hostId?: string } | null)?.hostId === ALICE,
    doc,
  );

  const bob = await connect(BOB, "DURABLE");
  const caughtUp = await bob.next();
  check("a restarted server already knows the game", caughtUp.kind === "catch-up", caughtUp);
  const entries = (caughtUp.entries as { id: string; index: number }[]) ?? [];
  check("and hands back the stored entries with their original ids", entries.length === 1 && entries[0].id === storedIds[0], entries);

  /* THE FIRST SEAT MOVES ON THE RESTORED BOARD. The deal shuffles, so whichever of the two is on turn is
     tried second if the first is refused for the seat; the move must land for one of them, and its id must
     not be one the stored log already holds. */
  const alice2 = await connect(ALICE, "DURABLE");
  await alice2.next();
  const buy = { WaterfallBuyLowest: { game_id: 0 } };
  alice2.send({ kind: "submit", build: BUILD, baseIndex: 0, submissionId: "after-restart", msg: buy });
  let moved = await alice2.next();
  if (moved.kind === "refused") {
    check("a refusal after the restart is the seat's, not the store's", moved.reason === "It is not your turn.", moved);
    bob.send({ kind: "submit", build: BUILD, baseIndex: 0, submissionId: "after-restart", msg: buy });
    moved = await bob.next();
  }
  check("a move after the restart lands on the restored board", moved.kind === "applied", moved);
  const movedIds = moved.kind === "applied" ? (moved.entries as { id: string }[]).map((entry) => entry.id) : [];
  check(
    "and mints ids the stored log does not already hold",
    movedIds.length > 0 && movedIds.every((id) => !storedIds.includes(id)),
    { movedIds, storedIds },
  );
  check(
    "and the disk now holds both",
    fs.readFileSync(file, "utf8").trim().split("\n").length === 1 + movedIds.length,
  );

  alice2.socket.close();
  bob.socket.close();
  rejoined.socket.close();
  await second.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

void main();
