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

import { createGameServer, GAME_SERVER_BIND_HOST } from "./gameServer";
import { DEV_ORIGIN, devIdentity, devSocketUrl } from "./rooms/testSupport";
import type { LogStore } from "./fileLogStore";
import type { StagingRoomRecord } from "../../frontend/src/utils/lobbyProtocol";
import type { SandboxRoomDoc } from "../../frontend/src/utils/sandboxRoom";
// S10-5: the client's own chat frame shapes, so the harness cannot drift from what a browser reads.
import type { ChatFrame, ChatSendRequest } from "../../frontend/src/utils/roomDocLink";

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
    /* LIVE-2B: identity is the upgrade's -- `?dev_claim=` from a loopback Origin -- never a frame's. */
    const socket = new WebSocket(devSocketUrl(port, claim), { origin: DEV_ORIGIN });
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
      socket.send(JSON.stringify({ kind: "hello", room, build: BUILD, baseIndex: -1 }));
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

/** The same tiny client, speaking the waiting room's protocol instead of the log's (#1215).
 *
 *  ==================================================================
 *   STAGE 10.4 (S10-5): ROUTED BY KIND, THE WAY THE CLIENT ROUTES THEM
 *  ==================================================================
 *  THIS CLIENT USED TO HAND BACK WHATEVER FRAME CAME NEXT, and every check below read that frame as the room
 *  document. That was true until #1361a/#1361b put chat and presence on the same socket: `room-hello` is now
 *  answered with THREE frames -- `room`, then `chat` (the transcript), then `presence`. Five checks then read
 *  a chat frame (or, one step later, the frame the chat had displaced) as the roster and failed, although
 *  server and client agree
 *  (`roomDocLink.ts`: `room` goes to the document listeners, `error` to the error / refusal listeners, every
 *  other kind to its own listeners on the bus).
 *  SO THE HARNESS NOW DOES WHAT THE CLIENT DOES: one queue per kind. `next()` is the document channel and
 *  `nextOf(kind)` any other. Nothing is skipped silently: every frame is recorded in `seen`, in arrival order,
 *  and the checks below assert the hello's exact sequence, the orphan's, and a chat round trip. */
function connectRoom(claim: string, room: string): Promise<{
  socket: WebSocket;
  next: () => Promise<Frame>;
  nextOf: (kind: string) => Promise<Frame>;
  pending: (kind: string) => number;
  seen: string[];
  write: (write: unknown) => void;
  send: (frame: unknown) => void;
}> {
  return new Promise((resolve, reject) => {
    /* LIVE-2B: identity is the upgrade's -- `?dev_claim=` from a loopback Origin -- never a frame's. */
    const socket = new WebSocket(devSocketUrl(port, claim), { origin: DEV_ORIGIN });
    const queues = new Map<string, Frame[]>();
    const waiting = new Map<string, (frame: Frame) => void>();
    const seen: string[] = [];

    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      seen.push(frame.kind);
      const waiter = waiting.get(frame.kind);
      if (waiter) {
        waiting.delete(frame.kind);
        waiter(frame);
      } else {
        const queue = queues.get(frame.kind) ?? [];
        queue.push(frame);
        queues.set(frame.kind, queue);
      }
    });
    socket.on("error", reject);
    const nextOf = (kind: string) =>
      withTimeout(
        new Promise<Frame>((res) => {
          const queued = queues.get(kind)?.shift();
          if (queued) res(queued);
          else waiting.set(kind, res);
        }),
        `a ${kind} frame for ${claim} in ${room}`,
      );
    socket.on("open", () => {
      socket.send(JSON.stringify({ kind: "room-hello", room, build: BUILD }));
      resolve({
        socket,
        write: (write) => socket.send(JSON.stringify({ kind: "room-write", room, write })),
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: () => nextOf("room"),
        nextOf,
        pending: (kind) => queues.get(kind)?.length ?? 0,
        seen,
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
    identity: devIdentity(),
  });
  port = await listeningPort(server.http);

  /* LIVE-0: LOOPBACK, AS THE BANNER SAYS. The address the socket actually holds, not the constant it was
     asked for -- `listen(port)` with no host held every interface while the banner printed 127.0.0.1. */
  const bound = server.http.address();
  check(
    "the server listens on 127.0.0.1 only, not on every interface (LIVE-0)",
    GAME_SERVER_BIND_HOST === "127.0.0.1" && typeof bound === "object" && bound !== null && bound.address === "127.0.0.1",
    bound,
  );

  /* LIVE-2A (LIVE-2 §15 #9): A ROOM NOBODY HOSTED IS NOT DEALT. A hello to an invented code used to take a deal
     from anybody; now the deal is refused and nothing is stored. SMOKE is then hosted by Alice, exactly as the Host
     button does, before the deal below. */
  {
    const stranger = await connect(CAROL, "UNHOSTED");
    await stranger.next();
    stranger.send({
      kind: "submit",
      build: BUILD,
      baseIndex: -1,
      submissionId: "docless-deal",
      msg: { SetupGame: { players: [{ id: CAROL, nickname: "Carol" }, { id: BOB, nickname: "Bob" }], variants: {} } },
    });
    const docless = await stranger.next();
    check(
      "a deal in a room nobody hosted is refused, and names why (LIVE-2A)",
      docless.kind === "refused" && /no host/.test(String(docless.reason)),
      docless,
    );
    stranger.socket.close();
    const smokeHost = await connectRoom(ALICE, "SMOKE");
    smokeHost.write({ op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
    await smokeHost.next(); // the hello's answer: no room yet
    const smokeHosted = await smokeHost.next();
    check("Alice hosts SMOKE before dealing it (LIVE-2A)", roster(smokeHosted).length === 1, smokeHosted);
    smokeHost.socket.close();
  }

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
    submissionId: "skew-1", // LIVE-2A (LIVE-2 §11.3): every submit names its submission
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

  /* S10-5: the rest of the hello's answer (#1361a), asserted rather than skipped -- the transcript and the
     presence hints, each for this room, in the order the server sends them. */
  const hostChat = await hostRoom.nextOf("chat");
  check(
    "the hello also carries the room's chat transcript (#1361a)",
    hostChat.room === "LOBBY" && Array.isArray(hostChat.messages) && (hostChat.messages as unknown[]).length === 0,
    hostChat,
  );
  const hostPresence = await hostRoom.nextOf("presence");
  check(
    "and its presence hints (#1361a)",
    hostPresence.room === "LOBBY" && Array.isArray(hostPresence.entries) && typeof hostPresence.now === "number",
    hostPresence,
  );

  const hosted = await hostRoom.next();
  check(
    "a write sent before the hello is answered still lands (#1216)",
    roster(hosted).length === 1,
    hosted,
  );
  check(
    "the hello is answered room, chat, presence -- then the write's broadcast",
    JSON.stringify(hostRoom.seen.slice(0, 4)) === JSON.stringify(["room", "chat", "presence", "room"]),
    hostRoom.seen,
  );

  const joinRoom = await connectRoom(BOB, "LOBBY");
  const joinerFirst = await joinRoom.next();
  check("a joiner's first frame carries the room that already exists", roster(joinerFirst).length === 1);
  await joinRoom.nextOf("chat");
  await joinRoom.nextOf("presence");

  // A write to a room nobody hosted is dropped: a room whose host was whoever wrote first would hand out
  // the Start button by accident. The server answers with the document it still does not have.
  const orphan = await connectRoom(CAROL, "NOBODY");
  orphan.write({ op: "upsert-player", player: { id: CAROL, nickname: "Carol", isReady: false } });
  check("an orphan's hello finds no room", (await orphan.next()).doc === null);
  check("a write to an unhosted room does not invent one", (await orphan.next()).doc === null);
  check(
    "and is dropped, not refused: hello (room, chat, presence), then the unchanged document",
    JSON.stringify(orphan.seen) === JSON.stringify(["room", "chat", "presence", "room"]),
    orphan.seen,
  );
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

  /* S10-5: THE CHAT FRAME THE OLD HARNESS TRIPPED OVER, EXERCISED ON PURPOSE. A line sent by the joiner is
     stamped with the connection's identity and the whole transcript is broadcast to everyone in the room. */
  const line: ChatSendRequest = { kind: "chat-send", room: "LOBBY", text: "  hello table  ", displayName: "Bob" };
  joinRoom.send(line);
  const hostHeard = (await hostRoom.nextOf("chat")) as unknown as ChatFrame;
  const joinerHeard = (await joinRoom.nextOf("chat")) as unknown as ChatFrame;
  check(
    "a chat line reaches the whole room, stamped with its sender (#1361a)",
    hostHeard.messages.length === 1 &&
      hostHeard.messages[0].author === BOB &&
      hostHeard.messages[0].text === "hello table" &&
      JSON.stringify(joinerHeard.messages) === JSON.stringify(hostHeard.messages),
    hostHeard,
  );
  check(
    "and no refusal was left unread on either roster socket",
    hostRoom.pending("error") === 0 && joinRoom.pending("error") === 0 && hostRoom.pending("room") === 0 && joinRoom.pending("room") === 0,
    { host: hostRoom.seen, joiner: joinRoom.seen },
  );

  hostRoom.socket.close();
  joinRoom.socket.close();
  alice.socket.close();
  bob.socket.close();
  await server.close();

  await durableLog();

  await stagingLobbyParked();

  await durableBeforeVisible();

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
    identity: devIdentity(),
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
    identity: devIdentity(),
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

/* ==================================================================
    LIVE-0: THE STAGING LOBBY IS PARKED, AND THE JOIN GAME LIST IS NOT
   ==================================================================
   A store that already holds a staging room, as `lobby.json` does on a machine that ever used the Web3
   lobby. Parked, none of it may be answered and nothing may be written back -- while the SAME `lobby-hello`
   keeps carrying the public sandbox list (#1415), which is live. And no refusal may be an `error` frame:
   the client fans those out to every error listener on the lobby socket, the live lobby's banners among
   them. */
async function stagingLobbyParked(): Promise<void> {
  const now = Date.now();
  const stored: StagingRoomRecord = {
    room: {
      id: "r-stored-1",
      name: "Stored staging room",
      hostAddress: "juno1storedhost",
      hostDisplayName: "Host",
      maxPlayers: 4,
      seatCount: 1,
      status: "staging",
      chainGameId: null,
      anteUjuno: "1000000",
      virtualBankStart: "12000",
      variants: {} as StagingRoomRecord["room"]["variants"],
      createdAtMs: now,
      launchError: null,
    },
    seats: [
      { address: "juno1storedhost", displayName: "Host", ready: true, isHost: true, onChain: false, joinedAtMs: now, lastSeenMs: now },
    ],
  };
  let lobbySaves = 0;
  const docs = new Map<string, SandboxRoomDoc>();
  const store: LogStore = {
    loadLog: async () => [],
    appendLog: async () => undefined,
    loadRoomDoc: async (room) => docs.get(room) ?? null,
    saveRoomDoc: async (room, doc) => {
      docs.set(room, doc);
    },
    listRooms: async () => [...docs.keys()],
    loadLobby: async () => [stored],
    saveLobby: async () => {
      lobbySaves += 1;
    },
  };
  const server = createGameServer({ port: 0, build: BUILD, identity: devIdentity(), store });
  port = await listeningPort(server.http);

  const probe = await connectRoom(CAROL, "LIVE0-PROBE");
  await probe.next();

  probe.send({ kind: "lobby-hello" });
  const staging = await probe.nextOf("lobby");
  const listed = await probe.nextOf("rooms");
  check(
    "a lobby-hello answers no staging rooms, though the store holds one (LIVE-0)",
    Array.isArray(staging.rooms) && (staging.rooms as unknown[]).length === 0,
    staging,
  );
  check("and still answers the public sandbox list Join Game rides (#1415)", Array.isArray(listed.rooms), listed);

  probe.send({ kind: "lobby-watch", roomId: stored.room.id });
  const watched = await probe.nextOf("lobby-room");
  check(
    "a lobby-watch of that stored staging room sees no room and no seats",
    watched.roomId === stored.room.id && watched.room === null && Array.isArray(watched.seats) && (watched.seats as unknown[]).length === 0,
    watched,
  );

  probe.send({
    kind: "lobby-write",
    requestId: "live0-create",
    write: { op: "create-room", name: "x", maxPlayers: 4, hostAddress: "juno1x", hostDisplayName: "X", anteUjuno: "0", virtualBankStart: "12000", variants: {} },
  });
  const created = await probe.nextOf("lobby-ack");
  probe.send({ kind: "lobby-write", requestId: "live0-bind", write: { op: "bind-chain-game-id", roomId: stored.room.id, chainGameId: 7 } });
  const chained = await probe.nextOf("lobby-ack");
  check(
    "a lobby-write is refused in its own ack -- create-room and bind-chain-game-id alike",
    created.requestId === "live0-create" && created.ok === false && typeof created.reason === "string" &&
      chained.requestId === "live0-bind" && chained.ok === false,
    { created, chained },
  );

  /* THE LIVE PATH, UNCHANGED: a public sandbox room hosted after the hello reaches that socket's list. */
  const host = await connectRoom(ALICE, "LIVE0-PUBLIC");
  await host.next();
  host.write({ op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
  await host.next();
  const relisted = await probe.nextOf("rooms");
  check(
    "a public sandbox room hosted after the hello still reaches that socket's list",
    Array.isArray(relisted.rooms) && (relisted.rooms as { code: string }[]).some((row) => row.code === "LIVE0-PUBLIC"),
    relisted,
  );

  check("nothing was written back to the staging lobby's store", lobbySaves === 0, lobbySaves);
  check("and no refusal went out as an `error` frame", !probe.seen.includes("error"), probe.seen);

  host.socket.close();
  probe.socket.close();
  await server.close();
}

/* ==================================================================
    LIVE-3A: DURABLE BEFORE VISIBLE, OVER A REAL SOCKET
   ==================================================================
   The checks `rooms/gameActor.test.ts` makes in depth, made once here where anybody runs them: a hello's answer
   marks the protocol (`inFlight`); a move held at the store is invisible to a hello until the store has it; the
   submitter's answer names its submission and the watcher's copy does not; two sockets' back-to-back moves reach
   a watcher in commit order; and a client claiming history the room does not hold is refused `ahead`. The store
   here holds each append until the check lets it go. */
async function durableBeforeVisible(): Promise<void> {
  const gates: Array<{ reached: () => void; opened: Promise<void> }> = [];
  const hold = () => {
    let open: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const opened = new Promise<void>((resolve) => (open = resolve));
    gates.push({ reached, opened });
    return { arrived, open };
  };
  const store: LogStore = {
    loadLog: async () => [],
    appendLog: async () => {
      const held = gates.shift();
      if (held) {
        held.reached();
        await held.opened;
      }
    },
    /* LIVE-2A (LIVE-2 §15 #9): the room is hosted by Alice, so it can be dealt. */
    loadRoomDoc: async (code) =>
      code === "LIVE3A"
        ? ({
            code,
            hostId: ALICE,
            status: "waiting",
            players: [{ id: ALICE, nickname: "Alice", isReady: false }],
            variants: {},
            forcedSign: null,
            visibility: "public",
            playerCount: null,
            anteUjuno: "0",
            createdAtMs: 0,
            kicked: [],
          } as never)
        : null,
    saveRoomDoc: async () => undefined,
  };
  const server = createGameServer({ port: 0, build: BUILD, identity: devIdentity(), store });
  port = await listeningPort(server.http);
  const room = "LIVE3A";
  const next = async (client: { next: () => Promise<Frame> }, wanted: (frame: Frame) => boolean) => {
    for (;;) {
      const frame = await client.next();
      if (wanted(frame)) return frame;
    }
  };
  const indexOf = (frame: Frame) => (frame.entries as { index: number }[] | undefined)?.[0]?.index;

  const alice = await connect(ALICE, room);
  const aliceHello = await alice.next();
  check(
    "a hello's answer carries `inFlight`: replies now name the submission they answer (LIVE-3A)",
    aliceHello.kind === "catch-up" && Array.isArray(aliceHello.inFlight),
    aliceHello,
  );

  const deal = hold();
  alice.send({
    kind: "submit",
    build: BUILD,
    baseIndex: -1,
    submissionId: "held-deal",
    msg: { SetupGame: { players: [{ id: ALICE, nickname: "Alice" }, { id: BOB, nickname: "Bob" }], variants: {} } },
  });
  await deal.arrived;
  const bob = await connect(BOB, room);
  const bobHello = await bob.next();
  check(
    "a hello while the deal awaits the disk is answered from what is durable -- nothing (LIVE-3 P1)",
    bobHello.kind === "catch-up" && Array.isArray(bobHello.entries) && (bobHello.entries as unknown[]).length === 0,
    bobHello,
  );
  deal.open();
  const dealt = await alice.next();
  check("once durable, the submitter's answer names its submission", dealt.kind === "applied" && dealt.inReplyTo === "held-deal", dealt);
  const heard = await bob.next();
  check(
    "and the watcher's copy of the same news names none",
    heard.kind === "applied" && heard.inReplyTo === undefined && JSON.stringify(heard.entries) === JSON.stringify(dealt.entries),
    heard,
  );

  const carol = await connect(CAROL, room);
  await carol.next();
  const first = hold();
  alice.send({ kind: "submit", build: BUILD, baseIndex: 0, submissionId: "a-buy", msg: { WaterfallBuyLowest: { game_id: 0 } } });
  await first.arrived;
  // Bob's move for the board after Alice's is sent while hers is still at the disk: it waits for it.
  bob.send({ kind: "submit", build: BUILD, baseIndex: 1, submissionId: "b-buy", msg: { WaterfallBuyLowest: { game_id: 0 } } });
  first.open();
  const watched = [await carol.next(), await carol.next()];
  check(
    "back-to-back moves from two sockets reach a watcher in commit order (LIVE-3 F-6)",
    watched.every((frame) => frame.kind === "applied") && indexOf(watched[0]) === 1 && indexOf(watched[1]) === 2,
    watched,
  );
  const bobs = await next(bob, (frame) => frame.inReplyTo === "b-buy");
  check("and the second one was judged on the first, durable: applied at index 2", bobs.kind === "applied" && indexOf(bobs) === 2, bobs);

  alice.send({ kind: "submit", build: BUILD, baseIndex: 9, submissionId: "a-ahead", msg: { PassTurn: { game_id: 0 } } });
  const ahead = await next(alice, (frame) => frame.inReplyTo === "a-ahead");
  check(
    "a client claiming history the room does not hold is refused `ahead`, and counted (LIVE-3 §5.2)",
    ahead.kind === "refused" && ahead.code === "ahead" && ahead.watermark === 2 && server.counters.submitAhead === 1,
    ahead,
  );

  alice.socket.close();
  bob.socket.close();
  carol.socket.close();
  await server.close();
}

void main();
