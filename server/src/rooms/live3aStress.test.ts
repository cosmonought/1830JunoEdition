// server/src/rooms/live3aStress.test.ts
//
// LIVE-3A: a bounded, seeded stress run -- LIVE-3's P5 model check, promoted into a test against the real
// server, the real `RoomSession`, the real client link (`serverLink.ts`) and real sockets.
//
// Several clients submit into one game at once, from seeded choices, while the store delays every append and
// fails some, and sockets are dropped and reconnect. LIVE-3B: the store answers with its classified outcomes --
// some appends DEFINITELY fail (nothing written), some are uncertain and REDONE by the store (written once,
// committed), and some answer only after the actor's store timeout (E-11), then land or definitely fail. Whatever
// the interleaving, the invariants hold:
//   - the store holds no duplicate index and no gap;
//   - no client is ever sent an entry the store does not already hold at that index (checked on receipt);
//   - no client holds two different entries at one index, is handed one entry twice, or has to resync;
//   - every submission settles, and it resolves with an index exactly when the store holds it there -- a `null`
//     is a move that never landed, so trying again can never make it twice;
//   - once quiet, every client holds exactly the store's history, and a session restored from the store has the
//     digest the committed view publishes.
// `LIVE3A_SEEDS` raises the number of schedules (the design's nightly run is 10,000 -- LIVE-3D's).

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { connectServerLink, type ServerLink, type SocketLike } from "../../../frontend/src/utils/serverLink";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { stateDigest } from "../../../frontend/src/gameEngine";
import type { LogStore } from "../fileLogStore";
import { COMMITTED, throwUnlessCommitted, type StoreWriteOutcome } from "../persistence/storeResult";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  PASS,
  probeSession,
  quietConsole,
  sleep,
  hostedDoc,
  startServer,
  stopServer,
  until,
} from "./testSupport";

quietConsole();

const SEEDS = Number(process.env.LIVE3A_SEEDS ?? 30);
const STEPS = 40;
const ROOM = "STRESS";
const PLAYERS = [ALICE, BOB, CAROL] as const;
const DEAL = { SetupGame: { players: PLAYERS.map((id) => ({ id, nickname: id })), variants: {} } };

/** A small, well-known 32-bit generator: the same seed, the same schedule of choices. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The actor's store timeout in this run (E-11): short, so some appends answer late. */
const STORE_TIMEOUT_MS = 12;

/** Appends are delayed 0-3 ms. 5% definitely fail (nothing written); 5% were uncertain and the store's REDO made them
 *  durable (written once, `committed`, `redone`); 4% answer only after the actor's timeout (E-11) and then land or
 *  definitely fail, half each. The log only grows, as a file does. */
function faultyStore(random: () => number) {
  const log: ServerLogEntry[] = [];
  /* LIVE-2A (LIVE-2 §15 #9): the room is hosted by the player who deals it -- a doc-less deal is refused now. */
  let doc: string | null = JSON.stringify(hostedDoc(ROOM, ALICE));
  const stats = { appends: 0, lost: 0, landed: 0, late: 0, inFlight: 0 };
  const appendBatch = async (_room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> => {
    stats.appends += 1;
    stats.inFlight += 1;
    try {
      const roll = random();
      if (roll >= 0.1 && roll < 0.14) {
        stats.late += 1;
        await sleep(STORE_TIMEOUT_MS + 5 + Math.floor(random() * 20));
        if (random() < 0.5) return { kind: "definite", detail: "injected: late, then nothing written" };
        log.push(...(JSON.parse(JSON.stringify(entries)) as ServerLogEntry[]));
        return COMMITTED;
      }
      await sleep(Math.floor(random() * 4));
      if (roll < 0.05) {
        stats.lost += 1;
        return { kind: "definite", detail: "injected: nothing written" };
      }
      log.push(...(JSON.parse(JSON.stringify(entries)) as ServerLogEntry[]));
      if (roll < 0.1) {
        stats.landed += 1;
        return { kind: "committed", redone: true }; // written, the sync failed, the redo made it durable
      }
      return COMMITTED;
    } finally {
      stats.inFlight -= 1;
    }
  };
  const store: LogStore = {
    loadLog: async () => JSON.parse(JSON.stringify(log)) as ServerLogEntry[],
    appendBatch,
    appendLog: async (room, entries) => throwUnlessCommitted(await appendBatch(room, entries)),
    loadRoomDoc: async () => (doc === null ? null : JSON.parse(doc)),
    saveRoomDoc: async (_room, next) => {
      doc = JSON.stringify(next);
    },
  };
  return { store, log, stats };
}

interface Player {
  claim: string;
  link: ServerLink;
  history: Map<number, string>;
  outcomes: Array<{ id: string; result: number | null | "pending" }>;
  violations: string[];
  drop(): void;
}

function player(port: number, claim: string, durable: () => readonly ServerLogEntry[]): Player {
  let socket: WebSocket | null = null;
  let minted = 0;
  const history = new Map<number, string>();
  const violations: string[] = [];
  const link = connectServerLink({
    url: `ws://127.0.0.1:${port}`,
    room: ROOM,
    build: BUILD,
    claim,
    mintSubmissionId: () => `${claim}-${(minted += 1)}`,
    schedule: (callback) => {
      setTimeout(callback, 3);
    },
    socketFactory: (url) => {
      const current = new WebSocket(url);
      socket = current;
      const like: SocketLike = {
        send: (data) => {
          if (current.readyState === WebSocket.OPEN) current.send(data);
        },
        close: () => current.close(),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      current.on("open", () => like.onopen?.({}));
      current.on("message", (data) => like.onmessage?.({ data: String(data) }));
      current.on("close", () => like.onclose?.({}));
      current.on("error", () => like.onerror?.({}));
      return like;
    },
    onEntries: (entries) => {
      const stored = durable();
      for (const entry of entries) {
        if (stored[entry.index]?.id !== entry.id) {
          violations.push(`${claim} was sent index ${entry.index} (${entry.id}) that the store does not hold there`);
        }
        const had = history.get(entry.index);
        if (had !== undefined && had !== entry.id) violations.push(`${claim} holds two entries at index ${entry.index}`);
        if (had === entry.id) violations.push(`${claim} was handed index ${entry.index} twice`);
        history.set(entry.index, entry.id);
      }
    },
    onResync: (reason) => {
      violations.push(`${claim} had to resync: ${reason}`);
      history.clear();
    },
  });
  return {
    claim,
    link,
    history,
    outcomes: [],
    violations,
    drop: () => socket?.terminate(),
  };
}

test(`seeded concurrent submits, faulty appends and reconnects: ${SEEDS} schedules x ${STEPS} steps`, async () => {
  let lostTotal = 0;
  let landedTotal = 0;
  let lateTotal = 0;
  let droppedTotal = 0;
  let committedTotal = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const choose = mulberry32(seed);
    const faults = faultyStore(mulberry32(seed * 7919));
    const { server, port } = await startServer({ store: faults.store, storeTimeoutMs: STORE_TIMEOUT_MS });
    const players = PLAYERS.map((claim) => player(port, claim, () => faults.log));
    const pending: Array<Promise<void>> = [];
    const submit = (who: Player, msg: object) => {
      const outcome: Player["outcomes"][number] = { id: "", result: "pending" };
      const settled = who.link.submit(msg as never).then((index) => {
        outcome.result = index;
      });
      outcome.id = `${who.claim}-${who.outcomes.length + 1}`;
      who.outcomes.push(outcome);
      pending.push(settled);
    };
    try {
      submit(players[0], DEAL);
      for (let step = 0; step < STEPS; step += 1) {
        const who = players[Math.floor(choose() * players.length)];
        const roll = choose();
        if (roll < 0.12) {
          who.drop();
          droppedTotal += 1;
        } else if (roll < 0.8) {
          const pick = choose();
          const msg =
            pick < 0.55
              ? BUY
              : pick < 0.75
                ? PASS
                : { RevertTo: { index: 1_000_000, player: who.claim, summary: "stress" } };
          submit(who, msg);
        }
        await sleep(Math.floor(choose() * 4));
      }

      // Quiet: every submission settles, nothing is being appended, and every client has caught up.
      await Promise.race([
        Promise.all(pending),
        sleep(10_000).then(() => {
          throw new Error(`seed ${seed}: a submission never settled`);
        }),
      ]);
      await until(() => faults.stats.inFlight === 0, `seed ${seed}: the store to go quiet`);
      await until(
        () => players.every((each) => each.link.appliedIndex === faults.log.length - 1),
        `seed ${seed}: every client to catch up to ${faults.log.length - 1}`,
        6000,
      );

      // No duplicate index, no gap.
      faults.log.forEach((entry, at) => assert.equal(entry.index, at, `seed ${seed}: the store is not contiguous at ${at}`));
      assert.equal(new Set(faults.log.map((entry) => entry.id)).size, faults.log.length, `seed ${seed}: a repeated id`);

      for (const each of players) {
        assert.deepEqual(each.violations, [], `seed ${seed}: ${each.claim}`);
        // Exactly the store's history.
        assert.equal(each.history.size, faults.log.length, `seed ${seed}: ${each.claim} holds a different length`);
        for (const entry of faults.log) assert.equal(each.history.get(entry.index), entry.id, `seed ${seed}: ${each.claim} diverged`);
        // An index exactly when the store holds the submission there; null exactly when it never landed.
        for (const outcome of each.outcomes) {
          const at = faults.log.findIndex((entry) => entry.submission_id === outcome.id && entry.actor === each.claim);
          if (typeof outcome.result === "number") {
            assert.equal(at, outcome.result, `seed ${seed}: ${outcome.id} resolved ${outcome.result} but is stored at ${at}`);
          } else {
            assert.equal(outcome.result, null, `seed ${seed}: ${outcome.id} never settled`);
            assert.equal(at, -1, `seed ${seed}: ${outcome.id} resolved null but the store holds it -- a second attempt would double it`);
          }
        }
      }

      // The committed view is the store's board.
      const observer = await Client.open(port, "p-observer");
      observer.hello(ROOM);
      const view = await observer.next((frame) => frame.kind === "catch-up");
      const restored = probeSession("stress-verify");
      if (faults.log.length > 0) restored.restore(faults.log);
      assert.equal(view.digest, stateDigest(restored.state), `seed ${seed}: the restored board is not the published one`);
      assert.equal(server.counters.submitAhead + server.counters.helloResync, 0, `seed ${seed}: a resync on a single store`);

      lostTotal += faults.stats.lost;
      landedTotal += faults.stats.landed;
      lateTotal += faults.stats.late;
      committedTotal += faults.log.length;
      await observer.close();
    } finally {
      for (const each of players) each.link.close();
      await stopServer(server);
    }
  }
  // The faults were exercised, not merely configured.
  assert.ok(lostTotal > 0 && landedTotal > 0 && lateTotal > 0 && droppedTotal > 0 && committedTotal > SEEDS, "faults exercised");
});
