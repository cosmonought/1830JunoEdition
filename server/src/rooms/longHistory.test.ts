// server/src/rooms/longHistory.test.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS (owner ruling, 2026-10-07): NO GAMEPLAY HISTORY CAP -- A LONG GAME THROUGH THE REAL SERVER
// ==================================================================
//
// A long but valid game must never become unplayable because of its length. Through the REAL server, its FILE stores
// (log, record, hold, clock) and real sockets, a dealt Live table is played to its second Stock Round and then well past
// 10,000 authoritative log entries of legal play (a seat offering a private to the other and taking the offer back,
// again and again -- each one a real, hashed, durable entry). Then:
//
//   PLAYABLE     an offer, its rescission and a required action are still taken; the clock still runs (the overdue
//                comes at 20:00 and names the cumulative log hash of exactly that history);
//   APPEND       every entry is durable, contiguous and in order in the store;
//   HASH         the cumulative (checkpointed) log hash equals the full SHA-256 over every line;
//   RELOAD       a restarted server loads the whole history (page by page where the store pages) and replays it to the
//                same board; the next move is appended past it;
//   CATCH-UP     a client that reassembles pages gets the history as consecutive pages -- never one frame over the
//                page bound -- equal entry for entry to a legacy client's single frame, with the same digest; a frame
//                for that socket that arrives meanwhile waits behind the pages.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore } from "../fileLogStore";
import { CATCH_UP_PAGE_BYTES, type GameServerOptions } from "../gameServer";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import type { RoomClockView } from "../../../frontend/src/utils/clockProtocol";
import { cumulativeLogHash, logHash } from "../../../frontend/src/gameEngine/logHash";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { createFileHoldStore } from "./holdStore";
import { createFileRecordStore } from "./recordStore";
import { ALICE, BOB, BUILD, BUY, Client, PASS, quietConsole, startServer, stopServer, until, type Frame } from "./testSupport";
import { fakeTime, type FakeTime } from "./clock/clockTestSupport";
import { createFileClockStore } from "./clock/clockStore";
import { LIVE_ACTION_MS } from "./clock/clockRecord";

quietConsole();

const T0 = 1_780_000_000_000;
const quiet = { warn: () => undefined };
const TWO = [ALICE, BOB];
/** Past the former cap by a margin: the history this suite plays. */
const TARGET_ENTRIES = 10_400;

const UNLIMITED = { capacity: 1e9, refillPerSecond: 1e9 };
const LIMITS: GameServerOptions["limits"] = {
  buckets: { submit: UNLIMITED },
  maxPendingFrames: 256,
  rooms: { offersPerSeat: UNLIMITED, offersPerSeatSustained: UNLIMITED },
};

async function boot(dir: string, time: FakeTime) {
  const { server, port } = await startServer({
    store: createFileLogStore(dir, quiet),
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    clock: { store: createFileClockStore(dir, quiet), authority: "auth-1", now: time.now, timers: time.timers },
    ops: createMemoryOpsRecorder(),
    limits: LIMITS,
  });
  await server.lifecycle.ready;
  time.drain = async () => {
    await server.clock?.idle();
  };
  return { server, port };
}

const lastIndex = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

async function submit(port: number, claim: string, gameId: string, msg: object, label: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  await client.next((frame) => frame.kind === "catch-up", "the catch-up");
  client.submit(msg, { baseIndex: lastIndex(client), submissionId: label });
  const answer = await client.answerTo(label);
  await client.close();
  return answer;
}

async function play(port: number, claim: string, gameId: string, msg: object, label: string): Promise<void> {
  const answer = await submit(port, claim, gameId, msg, label);
  assert.equal(answer.kind, "applied", `${label}: ${JSON.stringify(answer)}`);
}

async function openTable(port: number): Promise<{ gameId: string; ids: Record<string, string> }> {
  const host = await Client.open(port, ALICE);
  const created = await host.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: ALICE });
  assert.equal(created.ok, true, JSON.stringify(created));
  const { gameId, code, playerId } = created.data as { gameId: string; code: string; playerId: string };
  const guest = await Client.open(port, BOB);
  const joined = await guest.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  for (const client of [host, guest]) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
  assert.equal((await host.op({ type: "start-game" }, gameId)).ok, true);
  await Promise.all([host.close(), guest.close()]);
  return { gameId, ids: { [ALICE]: playerId, [BOB]: (joined.data as { playerId: string }).playerId } };
}

/** The dealt two-seat table played to its SECOND Stock Round, where a seat may offer a private to the other. */
async function toSecondStockRound(port: number, gameId: string, ids: Record<string, string>): Promise<{ seller: string; buyer: string; privateId: number }> {
  let n = 0;
  const either = async (msg: (claim: string) => object, label: string): Promise<string | null> => {
    for (const claim of TWO) {
      if ((await submit(port, claim, gameId, msg(claim), `${label}-${(n += 1)}`)).kind === "applied") return claim;
    }
    return null;
  };
  for (let bought = 0; bought < 6; ) {
    if ((await either(() => BUY, "buy")) !== null) {
      bought += 1;
      continue;
    }
    assert.notEqual(await either((claim) => ({ SetBoPar: { player: ids[claim], par_value: "100" } }), "bo-par"), null);
  }
  await either((claim) => ({ SetBoPar: { player: ids[claim], par_value: "100" } }), "bo-par-late");
  await play(port, ALICE, gameId, { OpenStockRound: {} }, "open-sr");
  for (let pass = 0; pass < 2; pass += 1) assert.notEqual(await either(() => PASS, "sr1-pass"), null);
  for (const seller of TWO) {
    const buyer = seller === ALICE ? BOB : ALICE;
    for (let privateId = 1; privateId <= 6; privateId += 1) {
      const tried = await submit(port, seller, gameId, offerOf(privateId, ids[seller], ids[buyer]), `probe-${(n += 1)}`);
      if (tried.kind === "applied") {
        await play(port, seller, gameId, { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, `probe-rescind-${n}`);
        return { seller, buyer, privateId };
      }
    }
  }
  throw new Error("no seat could offer a private");
}

const offerOf = (privateId: number, sellerId: string, buyerId: string, price = 10) => ({ ProposePrivateTrade: { game_id: 0, private_id: privateId, seller: sellerId, buyer: buyerId, price } });

const latestClock = (client: Client): RoomClockView | undefined => {
  const rooms = client.of("room");
  return (rooms[rooms.length - 1]?.view as { clock?: RoomClockView } | undefined)?.clock;
};

/** A paging client's hello: the pages up to and including the last one (no `more`). */
async function pagedCatchUp(client: Client, gameId: string): Promise<Frame[]> {
  client.send({ kind: "hello", gameId, build: BUILD, baseIndex: -1, pages: 1 });
  const pages: Frame[] = [];
  for (;;) {
    const page = await client.next((frame) => frame.kind === "catch-up", "a catch-up page");
    pages.push(page);
    if (page.more !== true) return pages;
  }
}

const storedLog = async (dir: string, gameId: string): Promise<readonly ServerLogEntry[]> => createFileLogStore(dir, quiet).loadLog(gameId);

describe("No gameplay history cap: a game past 10,000 entries through the real server and its file stores", () => {
  test(`${TARGET_ENTRIES}+ entries of legal play: still playable, durable, hashed, reloaded, replayed and caught up in pages`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-longhistory-"));
    const time = fakeTime(T0);
    let booted = await boot(dir, time);
    try {
      const { gameId, ids } = await openTable(booted.port);
      const { seller, buyer, privateId } = await toSecondStockRound(booted.port, gameId, ids);

      /* ---- the long game: offers and rescissions, pipelined on one socket (each one a durable entry) ---- */
      const bulk = await Client.open(booted.port, seller);
      bulk.hello(gameId);
      await bulk.next((frame) => frame.kind === "catch-up", "the bulk catch-up");
      let base = lastIndex(bulk);
      let move = 0;
      while (base + 1 < TARGET_ENTRIES) {
        const burst = 40;
        const labels: string[] = [];
        for (let k = 0; k < burst; k += 1) {
          const label = `bulk-${(move += 1)}`;
          labels.push(label);
          bulk.submit(move % 2 === 1 ? offerOf(privateId, ids[seller], ids[buyer], 10 + (move % 5)) : { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, { baseIndex: base + k, submissionId: label });
        }
        for (const label of labels) {
          const answer = await bulk.answerTo(label);
          assert.equal(answer.kind, "applied", `${label}: ${JSON.stringify(answer).slice(0, 300)}`);
        }
        base += burst;
        if (process.env.LONG_HISTORY_VERBOSE === "1" && move % 1000 === 0) process.stderr.write(`[long-history] ${base + 1} entries at ${Date.now()}\n`);
      }
      assert.equal(move % 2, 0, "every offer was taken back");
      await bulk.close();

      /* PLAYABLE past 10,000: an offer, its rescission, then the required action itself. */
      await play(booted.port, seller, gameId, offerOf(privateId, ids[seller], ids[buyer]), "late-offer");
      await play(booted.port, seller, gameId, { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, "late-rescind");
      await play(booted.port, seller, gameId, PASS, "late-pass");

      /* APPEND + HASH: durable, contiguous, and the cumulative hash is the full digest. */
      const durable = await storedLog(dir, gameId);
      assert.ok(durable.length > TARGET_ENTRIES, `the history is ${durable.length} entries`);
      durable.forEach((entry, at) => assert.equal(entry.index, at, "contiguous, in order"));
      const full = logHash(durable);
      assert.equal(cumulativeLogHash(durable), full);
      assert.equal(cumulativeLogHash(durable, 10_001), logHash(durable, 10_001), "any prefix, from the segment checkpoints");

      /* The clock is not frozen by the length: the next seat's 20:00 runs out and the overdue names exactly this
         history's length and cumulative hash. */
      const watcher = await Client.open(booted.port, ALICE);
      watcher.roomHello(gameId);
      await until(() => latestClock(watcher) !== undefined, "the clock view");
      await time.advance(LIVE_ACTION_MS);
      await until(() => latestClock(watcher)?.overdue !== undefined && latestClock(watcher)?.overdue !== null, `the overdue (${JSON.stringify(latestClock(watcher))?.slice(0, 300)})`, 10_000);
      const overdue = latestClock(watcher)?.overdue as { logLen: number; logHash: string };
      const atOverdue = await storedLog(dir, gameId);
      assert.equal(overdue.logLen, atOverdue.length);
      assert.equal(overdue.logHash, logHash(atOverdue));
      await watcher.close();

      /* ---- RELOAD: a restarted server (the same authority, no time lost) loads and replays the whole history ---- */
      await stopServer(booted.server);
      booted = await boot(dir, time);
      const legacy = await Client.open(booted.port, buyer);
      legacy.hello(gameId);
      const single = await legacy.next((frame) => frame.kind === "catch-up", "the legacy catch-up", );
      assert.equal(single.more, undefined, "a client that did not ask for pages gets the one frame it always did");
      const reloaded = await storedLog(dir, gameId);
      assert.deepEqual((single.entries as ServerLogEntry[]).map((entry) => entry.id), reloaded.map((entry) => entry.id));

      /* CATCH-UP IN PAGES: bounded pages, reassembled exactly; the same digest as the single frame. */
      const paged = await Client.open(booted.port, seller);
      const pages = await pagedCatchUp(paged, gameId);
      assert.ok(pages.length >= 2, `${pages.length} pages`);
      for (const page of pages.slice(0, -1)) {
        assert.equal(page.more, true);
        assert.equal(page.digest, "", "a page carries no verdict");
        assert.ok(JSON.stringify(page.entries).length <= CATCH_UP_PAGE_BYTES + 2, "no page over the bound");
      }
      const last = pages[pages.length - 1];
      assert.equal(last.digest, single.digest, "the reassembled catch-up ends at the same board");
      assert.ok(Array.isArray(last.inFlight), "the hello's answer still says what is in flight");
      const whole = pages.flatMap((page) => page.entries as ServerLogEntry[]);
      assert.deepEqual(whole.map((entry) => [entry.index, entry.id]), reloaded.map((entry) => [entry.index, entry.id]));
      assert.ok(booted.server.ingress.catchUpStreams >= 1 && booted.server.ingress.catchUpPages >= 2);

      /* The next move is appended past the whole history; the paging socket receives it after its last page. */
      /* (The seller passed, so the buyer owes the next decision -- and is overdue: its owed action cures it.) */
      await play(booted.port, buyer, gameId, PASS, "after-reload");
      const grown = await storedLog(dir, gameId);
      assert.equal(grown.length, reloaded.length + 1, "appended past the reloaded history");
      const pushed = await paged.next((frame) => frame.kind === "applied", "the move after the pages");
      assert.equal((pushed.entries as ServerLogEntry[])[0].index, reloaded.length);
      assert.ok(paged.frames.indexOf(pushed) > paged.frames.indexOf(last), "after the last page");
      await Promise.all([legacy.close(), paged.close()]);
    } finally {
      await stopServer(booted.server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
