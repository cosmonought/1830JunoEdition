// server/src/conduct/p3PlayerReporting.test.ts
//
// ==================================================================
//  PHASE 3 (P3-N035): REPORTING A PLAYER'S CONDUCT -- AGAINST THE REAL SERVER
// ==================================================================
//
// A. Reporting (development identity: every claim has its synthetic profile; real sockets, real room ops, a dealt game):
//    a seated player reports another seat; a watcher, an outsider of a private table, a kicked principal and a nonexistent
//    game cannot; the target must be ANOTHER seat of the same table; categories and notes are closed and bounded; the same
//    report again is the same case (two tabs at once included); the per-account budget refuses a flood without touching
//    anyone else; the evidence is the server's, bound to its committed log; nothing about the game, its record, its log
//    or its money moves; no private identifier is answered.
// B. Accounts and review (production identity, username/password accounts): a signed-out visitor cannot report or
//    review; only an account named in the reviewer list reads the queue (everyone else: 404, as if no route existed);
//    a decision needs a live "Confirm it's you", is CAS on the revision, persists (file store, across a restart) and is
//    never taken by a party to the case; trust facts never move because of a report.
// C. Pure: the evidence of the abusive train-offer example (counts and timeline, no motive inferred), the log pointer's
//    verification, the reviewers' configuration, and the import boundary (nothing outside `conduct/` and the wiring reads
//    a case: trust facts, money and identity never do).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { logHash } from "../../../frontend/src/gameEngine";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { MAX_REPORT_NOTE_LENGTH } from "../../../frontend/src/utils/conductReport";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createMemoryRecordStore } from "../rooms/recordStore";
import {
  accountBrowser,
  apiRequest,
  BUY,
  bootstrapCookie,
  Client,
  openGame,
  PROD_ORIGIN,
  quietConsole,
  startServer,
  stopServer,
  until,
  type Frame,
} from "../rooms/testSupport";
import { accountFingerprint, conductCaseId, decideCase, deriveEvidence, MAX_REPORTS_PER_SUBJECT, serializeConductCase, verifyLogPointer, type ConductCase } from "./conductCase";
import { createConductService, REPORT_SENTENCES } from "./conductService";
import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import type { RoomChatEntry } from "../../../frontend/src/utils/roomProtocol";
import { createFileConductCaseStore, createMemoryConductCaseStore, type ConductCaseStore } from "./conductStore";
import { conductReviewersFromEnv } from "./conductHttpApi";
import { readStoredLogForReview } from "./conductLogReader";
import { createFileLogStore } from "../fileLogStore";
import { NO_FACTS } from "../rooms/gameRecord";

quietConsole();

const PASSWORD = "correct horse battery";
const PRIVATE_ID = /\b(?:pr|pf|se|sf|rk)_[0-9a-z]|scrypt\$|password|login_key|cookie|__Host/;
const NOTE_OK = "Kept offering the same train after I declined, every few seconds.";

/* ---- development servers: reporting ---- */

async function devServer(over: { store?: ConductCaseStore; budget?: { capacity: number; refillPerSecond: number } } = {}) {
  const store = over.store ?? createMemoryConductCaseStore();
  const records = createMemoryRecordStore();
  const started = await startServer({ records, conduct: { store, ...(over.budget !== undefined ? { reporterBudget: over.budget } : {}) } });
  return { ...started, store, records };
}

/** A dealt public table (alice hosts; bob and carol sit) with a few real moves, and one socket per seat. */
async function dealtTable(port: number, over: { visibility?: "public" | "private"; moves?: number } = {}) {
  const game = await openGame(port, "alice", ["bob", "carol"], { visibility: over.visibility ?? "public" });
  const alice = await Client.open(port, "alice");
  const bob = await Client.open(port, "bob");
  const carol = await Client.open(port, "carol");
  alice.hello(game.gameId);
  await alice.next((frame) => frame.kind === "catch-up", "alice's catch-up");
  const moves = over.moves ?? 2;
  const order = [alice, bob, carol];
  for (let n = 0; n < moves; n += 1) {
    const seat = order[n % 3];
    if (seat !== alice) {
      seat.hello(game.gameId);
      await seat.next((frame) => frame.kind === "catch-up", `${seat.claim}'s catch-up`);
    }
    const base = await indexOf(port, game.gameId);
    const id = `buy-${n}`;
    seat.submit(BUY, { baseIndex: base, submissionId: id });
    const answer = await seat.answerTo(id);
    assert.equal(answer.kind, "applied", JSON.stringify(answer));
  }
  return { game, alice, bob, carol };
}

/** The committed log as a fresh reader sees it (the catch-up's entries). */
async function committedLog(port: number, gameId: string): Promise<ServerLogEntry[]> {
  const reader = await Client.open(port, "alice");
  reader.hello(gameId);
  const frame = await reader.next((candidate) => candidate.kind === "catch-up", "a reader's catch-up");
  await reader.close();
  return frame.entries as ServerLogEntry[];
}
const indexOf = async (port: number, gameId: string) => {
  const entries = await committedLog(port, gameId);
  return entries.length === 0 ? -1 : entries[entries.length - 1].index;
};

const report = (client: Client, gameId: string, body: Record<string, unknown>) => client.op({ type: "report-player", ...body }, gameId);
const allCases = async (store: ConductCaseStore): Promise<ConductCase[]> => Promise.all((await store.list()).map(async (id) => (await store.load(id)) as ConductCase));

/* ==================================================================
    A. REPORTING
   ================================================================== */

describe("P3-N035 A: a seated player reports another seat of the same table", () => {
  test("a participant reports another participant: one case, server-derived evidence bound to the committed log; the answer names nothing private", async () => {
    const { server, port, store } = await devServer();
    try {
      const { game, alice, bob } = await dealtTable(port);
      bob.send({ kind: "room-hello", gameId: game.gameId });
      await bob.next((frame) => frame.kind === "room", "bob's room view");
      bob.send({ kind: "chat-send", gameId: game.gameId, text: "hurry up\u001b[31m" });
      await until(() => bob.of("chat").some((frame) => (frame.messages as unknown[]).length > 0), "the chat line");
      const before = await committedLog(port, game.gameId);
      const ack = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "offer-spam", note: NOTE_OK });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      assert.deepEqual((ack.data as { received: string }).received, "new");
      assert.doesNotMatch(JSON.stringify(ack), PRIVATE_ID, "the answer carries no private identifier");
      assert.doesNotMatch(JSON.stringify(ack), /cc_[0-9a-f]{32}/, "nor a case id");

      const cases = await allCases(store);
      assert.equal(cases.length, 1);
      const value = cases[0];
      assert.equal(value.game_id, game.gameId);
      assert.equal(value.category, "offer-spam");
      assert.equal(value.status, "open");
      assert.equal(value.reporter.player_id, game.playerIds.alice);
      assert.equal(value.reported.player_id, game.playerIds.bob);
      assert.equal(value.reporter.principal_id, "pr_dev_alice", "the reporter's principal comes from the seat, server-side");
      assert.equal(value.reported.principal_id, "pr_dev_bob");
      assert.equal(value.note, NOTE_OK);
      /* The evidence: derived by the server, bound to the log it serves. */
      const evidence = value.evidence;
      assert.equal(evidence.source, "server");
      assert.equal(evidence.log.entries, before.length);
      assert.equal(evidence.log.hash, logHash(before), "the pointer is the committed log's hash at the report");
      assert.deepEqual(verifyLogPointer(evidence, before).verified, true);
      assert.equal(evidence.table.status, "active");
      assert.equal(evidence.rules.deal_pin !== null, true);
      assert.equal(evidence.timeline.length, before.length);
      assert.equal(evidence.counts.reported.actions >= 1, true, "bob's own moves are counted");
      assert.deepEqual(evidence.chat?.lines.map((line) => [line.by, line.text]), [["reported", "hurry up[31m"]], "the stored (sanitized) chat line of the reported seat");
      /* This server is built without a table clock: the case says the clock was not captured -- in words, never as an
         empty list (consolidated final integration: overdue / foreclosure events exist now, so no line denies them). */
      assert.equal(evidence.clock, null);
      assert.ok(evidence.not_captured.some((line) => /clock/i.test(line)), "what this build cannot capture is said in words");
      assert.ok(!evidence.not_captured.some((line) => /no such events/i.test(line)), "no line denies that overdue / foreclosure events exist");
      assert.doesNotMatch(JSON.stringify(evidence), /\b(?:pr|pf|se|sf|rk)_[0-9a-z]|cookie|password|127\.0\.0\.1|::1/, "no session, credential or address in the evidence");
      /* The reporter is alice (dev claim), never a client claim: the case id is the server's. */
      assert.equal(value.case_id, conductCaseId(game.gameId, "pr_dev_alice", "pr_dev_bob", "offer-spam", 0));
    } finally {
      await stopServer(server);
    }
  });

  test("a report changes nothing about the game: no entry, no applied frame, no record change, the same log and board", async () => {
    const { server, port, records } = await devServer();
    try {
      const { game, alice, bob, carol } = await dealtTable(port);
      for (const client of [alice, bob, carol]) {
        client.send({ kind: "room-hello", gameId: game.gameId });
        await client.next((frame) => frame.kind === "room", `${client.claim}'s room view`);
      }
      const logBefore = await committedLog(port, game.gameId);
      const framesBefore = [alice, bob, carol].map((client) => client.frames.length);
      const recordBefore = await records.load(game.gameId);
      const ack = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "stalling" });
      assert.equal(ack.ok, true, JSON.stringify(ack));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const logAfter = await committedLog(port, game.gameId);
      assert.deepEqual(logAfter, logBefore, "the committed log is byte-for-byte the same");
      for (const [at, client] of [alice, bob, carol].entries()) {
        const fresh = client.frames.slice(framesBefore[at]);
        assert.deepEqual(fresh.filter((frame) => frame.kind !== "room-ack").map((frame) => frame.kind), [], `${client.claim} was sent nothing about the report`);
      }
      assert.deepEqual(await records.load(game.gameId), recordBefore, "the GameRecord is unchanged (same version)");
    } finally {
      await stopServer(server);
    }
  });

  test("who may report: a watcher, an outsider of a private table, a kicked player and a nonexistent game cannot; never yourself; only a seat of this table", async () => {
    const { server, port, store } = await devServer();
    try {
      const { game, alice } = await dealtTable(port, { moves: 0 });
      const watcher = await Client.open(port, "walter");
      watcher.send({ kind: "room-hello", gameId: game.gameId });
      await watcher.next((frame) => frame.kind === "room", "the watcher's view");
      const watched = await report(watcher, game.gameId, { playerId: game.playerIds.bob, category: "harassment" });
      assert.equal(watched.ok, false);
      assert.equal(watched.code, "forbidden", "a watcher holds no seat");

      const hidden = await dealtTable(port, { visibility: "private", moves: 0 });
      const outsider = await Client.open(port, "olga");
      const unknown = await report(outsider, hidden.game.gameId, { playerId: hidden.game.playerIds.bob, category: "harassment" });
      const missing = await report(outsider, "g_0000000000000000000000000w", { playerId: hidden.game.playerIds.bob, category: "harassment" });
      assert.equal(unknown.code, "not-found");
      assert.deepEqual({ code: unknown.code, reason: unknown.reason }, { code: missing.code, reason: missing.reason }, "a private table is indistinguishable from no table");

      /* A kicked player (waiting table: the host removes them) holds no seat. */
      const waiting = await openGame(port, "hana", ["kim"], { start: false });
      const host = await Client.open(port, "hana");
      assert.equal((await host.op({ type: "kick", playerId: waiting.playerIds.kim }, waiting.gameId)).ok, true);
      const kim = await Client.open(port, "kim");
      const kicked = await report(kim, waiting.gameId, { playerId: waiting.playerIds.hana, category: "harassment" });
      assert.equal(kicked.ok, false);

      const self = await report(alice, game.gameId, { playerId: game.playerIds.alice, category: "other" });
      assert.deepEqual([self.ok, self.code], [false, "forbidden"]);
      const stranger = await report(alice, game.gameId, { playerId: hidden.game.playerIds.bob, category: "other" });
      assert.deepEqual([stranger.ok, stranger.code], [false, "not-found"], "a seat of ANOTHER table cannot be referenced");
      assert.match(String(stranger.reason), /not at this table/);
      assert.deepEqual(await store.list(), [], "nothing was recorded");
    } finally {
      await stopServer(server);
    }
  });

  test("the frame is closed: categories from the list only, a bounded note, no client-supplied evidence or seat fields", async () => {
    const { server, port, store } = await devServer();
    try {
      const { game, alice } = await dealtTable(port, { moves: 0 });
      const target = game.playerIds.bob;
      /* A malformed control frame is answered `error` (bad-frame), a well-formed one by its ack: whichever comes. */
      const refused = async (op: Record<string, unknown>): Promise<Frame> => {
        const requestId = `bad-${Math.random().toString(36).slice(2)}`;
        const from = alice.frames.length;
        alice.send({ kind: "room-op", requestId, gameId: game.gameId, op: { type: "report-player", ...op } });
        const answered = () => alice.frames.slice(from).find((frame) => frame.kind === "error" || (frame.kind === "room-ack" && frame.requestId === requestId));
        await until(() => answered() !== undefined, "the answer to a malformed report");
        return answered() as Frame;
      };
      for (const op of [
        { playerId: target, category: "cheating" },
        { playerId: target },
        { playerId: target, category: "stalling", note: "x".repeat(MAX_REPORT_NOTE_LENGTH * 2 + 1) },
        { playerId: target, category: "stalling", evidence: { log: { entries: 0 } } },
        { playerId: target, category: "stalling", reporter: "p-forged" },
        { playerId: target, category: "stalling", note: 7 },
        { playerId: "pr_dev_bob", category: "stalling" },
      ]) {
        const answer = await refused(op);
        assert.equal(answer.ok === true, false, `refused: ${JSON.stringify(op).slice(0, 80)}`);
        assert.equal(answer.code, "bad-frame", `bad-frame: ${JSON.stringify(op).slice(0, 80)} -> ${JSON.stringify(answer)}`);
      }
      /* Over the bound in characters (the frame carries up to twice as many UTF-16 units, for emoji): refused by the
         service, never cut; an emoji note of exactly the bound is received. */
      const long = await report(alice, game.gameId, { playerId: target, category: "stalling", note: "x".repeat(MAX_REPORT_NOTE_LENGTH + 1) });
      assert.deepEqual([long.ok, long.code], [false, "bad-note"]);
      /* A note that is not well-formed text is refused (never "repaired"); one with controls is cleaned. */
      const lone = await report(alice, game.gameId, { playerId: target, category: "stalling", note: "bad \ud800 surrogate" });
      assert.deepEqual([lone.ok, lone.code], [false, "bad-note"]);
      assert.deepEqual(await store.list(), []);
      const dirty = await report(alice, game.gameId, { playerId: target, category: "stalling", note: "  <script>alert(1)</script>‮​ line\nbreak\u0007  " });
      assert.equal(dirty.ok, true, JSON.stringify(dirty));
      const [value] = await allCases(store);
      assert.equal(value.note, "<script>alert(1)</script> line break", "controls, bidi and zero-width marks gone; whitespace collapsed; the text kept as data");
      const emoji = await report(alice, game.gameId, { playerId: game.playerIds.carol, category: "harassment", note: "😀".repeat(MAX_REPORT_NOTE_LENGTH) });
      assert.equal(emoji.ok, true, `an emoji note within the bound is received: ${JSON.stringify(emoji)}`);
    } finally {
      await stopServer(server);
    }
  });

  test("the same report again is the same case -- a repeat, a second tab at the same instant -- and costs nothing", async () => {
    const { server, port, store } = await devServer({ budget: { capacity: 2, refillPerSecond: 0.0001 } });
    try {
      const { game, alice } = await dealtTable(port, { moves: 0 });
      const tab2 = await Client.open(port, "alice");
      const body = { playerId: game.playerIds.bob, category: "stalling" };
      const [one, two] = await Promise.all([report(alice, game.gameId, body), report(tab2, game.gameId, { ...body, note: "the other tab" })]);
      const received = [one, two].map((answer) => (answer.data as { received: string }).received).sort();
      assert.deepEqual(received, ["already", "new"]);
      for (let n = 0; n < 5; n += 1) assert.equal(((await report(alice, game.gameId, body)).data as { received: string }).received, "already");
      assert.equal((await store.list()).length, 1);
      /* Duplicates spent nothing: the second NEW report still fits the budget of two. */
      assert.equal((await report(alice, game.gameId, { playerId: game.playerIds.carol, category: "stalling" })).ok, true);
      assert.equal((await store.list()).length, 2);
    } finally {
      await stopServer(server);
    }
  });

  test("the same complaint again once the game has moved on is ADDED to the active case (fresh pointer, counts, note); after a case is closed a report opens the next one", async () => {
    const { server, port, store } = await devServer();
    try {
      const { game, alice, carol } = await dealtTable(port);
      const body = { playerId: game.playerIds.bob, category: "stalling" };
      assert.equal(((await report(alice, game.gameId, body)).data as { received: string }).received, "new");
      carol.hello(game.gameId);
      await carol.next((frame) => frame.kind === "catch-up", "carol's catch-up");
      carol.submit(BUY, { baseIndex: await indexOf(port, game.gameId), submissionId: "carol-buy" });
      assert.equal((await carol.answerTo("carol-buy")).kind, "applied");
      const log = await committedLog(port, game.gameId);
      const added = await report(alice, game.gameId, { ...body, note: "Still doing it." });
      assert.equal((added.data as { received: string }).received, "new", `an addition is answered exactly like a new report: ${JSON.stringify(added)}`);
      assert.equal(((await report(alice, game.gameId, body)).data as { received: string }).received, "already", "nothing moved on since: the same report");
      const [first] = await allCases(store);
      assert.equal(first.rereports.length, 1);
      assert.equal(first.rereports[0].note, "Still doing it.");
      assert.deepEqual(first.rereports[0].log, { captured: true, entries: log.length, hash: logHash(log) }, "a fresh pointer into the log as it is now");
      assert.equal(first.revision, 2);
      assert.equal(first.status, "open", "a re-report never changes the review status");
      /* A reviewer closes it; the same complaint later is a NEW case, with its own evidence. */
      const closed = decideCase(first, { expectedRevision: first.revision, to: "no-violation", note: null, reviewerPrincipalId: "pr_dev_reviewer", now: Date.now() });
      if (!("next" in closed)) throw new Error(closed.reason);
      assert.equal((await store.save(closed.next, first.revision)).kind, "committed");
      /* The reporter cannot tell the case was closed: a repeat with nothing new is "already", exactly as while open. */
      assert.equal(((await report(alice, game.gameId, body)).data as { received: string }).received, "already");
      /* The game moves on (alice's turn again), and the same complaint is recorded -- answered as any new report. */
      alice.submit(BUY, { baseIndex: await indexOf(port, game.gameId), submissionId: "alice-2" });
      assert.equal((await alice.answerTo("alice-2")).kind, "applied");
      const afterClose = await report(alice, game.gameId, body);
      assert.equal((afterClose.data as { received: string }).received, "new");
      const cases = await allCases(store);
      assert.deepEqual(cases.map((value) => value.seq).sort(), [0, 1]);
      assert.equal((cases.find((value) => value.seq === 1)?.evidence.log.entries ?? 0) >= log.length, true);
    } finally {
      await stopServer(server);
    }
  });

  test("a case is keyed by the reported ACCOUNT: leaving and retaking a waiting seat (a new seat id) is the same case", async () => {
    const { server, port, store } = await devServer();
    try {
      const waiting = await openGame(port, "hana", ["kim"], { start: false });
      const hana = await Client.open(port, "hana");
      const kim = await Client.open(port, "kim");
      assert.equal((await report(hana, waiting.gameId, { playerId: waiting.playerIds.kim, category: "harassment" })).ok, true);
      assert.equal((await kim.op({ type: "release-seat" }, waiting.gameId)).ok, true);
      const retaken = await kim.op({ type: "take-seat" }, waiting.gameId);
      assert.equal(retaken.ok, true, JSON.stringify(retaken));
      const record = (await allCases(store))[0];
      const newSeat = (retaken.data as { playerId?: string } | undefined)?.playerId;
      if (newSeat !== undefined && newSeat !== waiting.playerIds.kim) {
        const again = await report(hana, waiting.gameId, { playerId: newSeat, category: "harassment" });
        assert.notEqual((again.data as { received: string }).received, "new", "the same account, the same case");
      }
      assert.equal((await store.list()).length, 1);
      assert.equal(record.reported.principal_id, "pr_dev_kim");
      assert.ok(record.table_principals.includes("pr_dev_hana") && record.table_principals.includes("pr_dev_kim"), "every seat of the table is recorded (server-side) as a party");
    } finally {
      await stopServer(server);
    }
  });

  test("the per-account budget refuses a flood from one account, with a retry hint, and never touches another account's reports", async () => {
    const { server, port, store } = await devServer({ budget: { capacity: 2, refillPerSecond: 0.0001 } });
    try {
      const { game, alice, carol } = await dealtTable(port, { moves: 0 });
      const categories = ["stalling", "offer-spam", "harassment", "collusion"];
      const answers = [];
      for (const category of categories) answers.push(await report(alice, game.gameId, { playerId: game.playerIds.bob, category }));
      assert.deepEqual(answers.map((answer) => answer.ok), [true, true, false, false]);
      assert.equal(answers[2].code, "rate-limited");
      assert.equal(typeof answers[2].retryAfterMs, "number");
      assert.equal((await store.list()).length, 2, "a refused report writes nothing");
      /* carol's own budget is untouched by alice's flood: there is no shared, global budget. */
      assert.equal((await report(carol, game.gameId, { playerId: game.playerIds.bob, category: "stalling" })).ok, true);
      assert.equal((await store.list()).length, 3);
    } finally {
      await stopServer(server);
    }
  });

  test("without a durable store a report is refused `unavailable` -- never kept in memory only", async () => {
    const { server, port } = await startServer({});
    try {
      const { game, alice } = await dealtTable(port, { moves: 0 });
      const answer = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "stalling" });
      assert.deepEqual([answer.ok, answer.code], [false, "unavailable"]);
    } finally {
      await stopServer(server);
    }
  });

  test("a store that fails: definite is 'not saved', uncertain is 'could not confirm' -- and the budget is given back", async () => {
    const store = createMemoryConductCaseStore();
    const { server, port } = await devServer({ store, budget: { capacity: 1, refillPerSecond: 0.0001 } });
    try {
      const { game, alice } = await dealtTable(port, { moves: 0 });
      store.failCreates.push("definite");
      const first = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "stalling" });
      assert.deepEqual([first.ok, first.code], [false, "unavailable"]);
      assert.match(String(first.reason), /could not be saved/);
      store.failCreates.push("uncertain-landed");
      const second = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "stalling" });
      assert.match(String(second.reason), /could not confirm/);
      const third = await report(alice, game.gameId, { playerId: game.playerIds.bob, category: "stalling" });
      assert.equal((third.data as { received: string }).received, "already", "the landed write is the case; the retry finds it");
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    B. ACCOUNTS, VISITORS AND REVIEW (production identity)
   ================================================================== */

/** A production server whose accounts (`accounts`) were made BEFORE it started -- as an operator makes a reviewer's
 *  account and then restarts with its name in GS_CONDUCT_REVIEWERS (the names are bound at startup). The accounts are
 *  made on a first server over the same identity service; their cookies stay valid on the second. */
async function prodServer(over: { store?: ConductCaseStore; reviewers?: readonly string[]; accounts?: readonly string[]; clock?: { now: number } } = {}) {
  const clock = over.clock ?? { now: Date.now() };
  const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const store = over.store ?? createMemoryConductCaseStore();
  const identity = { mode: "production" as const, allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service };
  const browsers: Record<string, { cookie: string; name: string }> = {};
  if ((over.accounts ?? []).length > 0) {
    const first = await startServer({ identity, records: createMemoryRecordStore(), conduct: { store } });
    try {
      for (const name of over.accounts ?? []) browsers[name] = await accountBrowser(first.port, name);
    } finally {
      await stopServer(first.server);
    }
  }
  const reviewers = conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: (over.reviewers ?? []).join(",") });
  if (!reviewers.ok) throw new Error(reviewers.reason);
  const started = await startServer({ identity, records: createMemoryRecordStore(), conduct: { store, reviewers: reviewers.reviewers } });
  return { ...started, clock, service, store, browsers };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });

/** A production table: the host creates, the guests join by code and sit; dealt. */
async function prodTable(port: number, host: { cookie: string; name: string }, guests: ReadonlyArray<{ cookie: string; name: string }>) {
  const hostClient = await Client.openWithCookie(port, host.cookie, host.name);
  const created = await hostClient.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: host.name });
  assert.equal(created.ok, true, JSON.stringify(created));
  const { gameId, code, playerId } = created.data as { gameId: string; code: string; playerId: string };
  const ids: Record<string, string> = { [host.name]: playerId };
  const clients: Record<string, Client> = { [host.name]: hostClient };
  for (const guest of guests) {
    const client = await Client.openWithCookie(port, guest.cookie, guest.name);
    const joined = await client.op({ type: "join", code, takeSeat: true });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    ids[guest.name] = (joined.data as { playerId: string }).playerId;
    clients[guest.name] = client;
  }
  for (const client of Object.values(clients)) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
  assert.equal((await hostClient.op({ type: "start-game" }, gameId)).ok, true);
  return { gameId, ids, clients };
}

describe("P3-N035 B: visitors, reviewers and the review workflow", () => {
  test("a signed-out visitor can neither report nor review; a non-reviewer account sees the review routes as absent", async () => {
    const { server, port } = await prodServer({ reviewers: ["Rita"], accounts: ["Rita"] });
    try {
      const ann = await accountBrowser(port, "Ann");
      const ben = await accountBrowser(port, "Ben");
      const table = await prodTable(port, { cookie: ann.cookie, name: "Ann" }, [{ cookie: ben.cookie, name: "Ben" }]);
      const visitorCookie = await bootstrapCookie(port);
      const visitor = await Client.openWithCookie(port, visitorCookie, "visitor");
      const answer = await visitor.op({ type: "report-player", playerId: table.ids.Ben, category: "harassment" }, table.gameId);
      assert.deepEqual([answer.ok, answer.code], [false, "profile-required"], "the visitor allow-list refuses the frame before any game is read");
      assert.equal((await post(port, "/gs/api/conduct/me")).status, 401);
      assert.equal((await post(port, "/gs/api/conduct/me", visitorCookie)).status, 403);
      assert.equal((await post(port, "/gs/api/conduct/review/queue", visitorCookie)).status, 403);
      const me = await post(port, "/gs/api/conduct/me", ann.cookie);
      assert.deepEqual(me.body, { ok: true, reviewer: false });
      for (const route of ["review/queue", "review/case", "review/decide"]) {
        const body = route === "review/queue" ? {} : route === "review/case" ? { caseId: "cc_" + "0".repeat(32) } : { caseId: "cc_" + "0".repeat(32), revision: 1, status: "no-violation" };
        const refused = await post(port, `/gs/api/conduct/${route}`, ann.cookie, body);
        assert.deepEqual([refused.status, refused.body], [404, { error: "not-found" }], `${route}: an ordinary account meets no such route`);
      }
      assert.equal((await post(port, "/gs/api/conduct/review/nothing", ann.cookie)).status, 404);
    } finally {
      await stopServer(server);
    }
  });

  test("a configured reviewer name nobody holds refuses the start (a typo or a not-yet-made account can never be squatted); a held name is bound", async () => {
    await assert.rejects(prodServer({ reviewers: ["Rita", "Moderator"], accounts: ["Rita"] }), /GS_CONDUCT_REVIEWERS names 1 username\(s\) no account holds/);
    const { server, port } = await prodServer({ reviewers: ["Rita"], accounts: ["Rita"] });
    try {
      const rita = await loginAgain(port, "Rita");
      assert.deepEqual((await post(port, "/gs/api/conduct/me", rita)).body, { ok: true, reviewer: true }, "a name held at startup is bound");
      const other = await accountBrowser(port, "Moderator");
      assert.deepEqual((await post(port, "/gs/api/conduct/me", other.cookie)).body, { ok: true, reviewer: false });
    } finally {
      await stopServer(server);
    }
  });

  test("a reviewer reads the queue and the case (fingerprints, never ids), decides only after Confirm it's you, CAS on the revision; a party never even sees the case", async () => {
    const clock = { now: Date.now() };
    const { server, port, store, browsers } = await prodServer({ reviewers: ["Rita", "Ann", "Cid"], accounts: ["Ann", "Ben", "Rita", "Cid"], clock });
    try {
      const { Ann: ann, Ben: ben, Rita: rita, Cid: cid } = browsers;
      const table = await prodTable(port, { cookie: ann.cookie, name: "Ann" }, [{ cookie: ben.cookie, name: "Ben" }, { cookie: cid.cookie, name: "Cid" }]);
      const reported = await table.clients.Ben.op({ type: "report-player", playerId: table.ids.Ann, category: "stalling", note: "Waited out the timer every turn." }, table.gameId);
      assert.equal(reported.ok, true, JSON.stringify(reported));

      assert.deepEqual((await post(port, "/gs/api/conduct/me", rita.cookie)).body, { ok: true, reviewer: true });
      const queue = await post(port, "/gs/api/conduct/review/queue", rita.cookie);
      assert.equal(queue.status, 200, queue.text);
      const cases = (queue.body as { cases: Array<Record<string, unknown>> }).cases;
      assert.equal(cases.length, 1);
      assert.doesNotMatch(queue.text, PRIVATE_ID, "the queue names no private identifier");
      const caseId = cases[0].caseId as string;
      assert.equal((cases[0].reported as { account: string }).account, accountFingerprint((await store.load(caseId))?.reported.principal_id as string));
      const view = await post(port, "/gs/api/conduct/review/case", rita.cookie, { caseId });
      assert.equal(view.status, 200, view.text);
      assert.doesNotMatch(view.text, PRIVATE_ID);
      const opened = (view.body as { case: { revision: number; note: string; verification: { verified: boolean | null }; related: { known: boolean } } }).case;
      assert.equal(opened.note, "Waited out the timer every turn.");
      assert.equal(opened.verification.verified, true, "the log pointer re-verifies against the resident game's committed log");
      assert.equal(opened.related.known, true);

      /* Past the sign-in's 5-minute grant: a decision needs Confirm it's you. */
      clock.now += 6 * 60_000;
      const unconfirmed = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision, status: "under-review" });
      assert.deepEqual([unconfirmed.status, unconfirmed.body], [403, { error: "reauth-required" }]);
      assert.equal((await post(port, "/gs/api/profile/reauth", rita.cookie, { password: PASSWORD })).status, 200);
      const decided = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision, status: "under-review", note: "Looking at the turn times." });
      assert.equal(decided.status, 200, decided.text);
      const stale = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision, status: "no-violation" });
      assert.deepEqual([stale.status, (stale.body as { error: string }).error], [409, "stale"]);
      const wrong = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision + 1, status: "open" });
      assert.deepEqual([wrong.status, (wrong.body as { error: string }).error], [409, "wrong-state"], "nothing moves back to open");
      const long = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision + 1, status: "no-violation", note: "x".repeat(1001) });
      assert.deepEqual([long.status, (long.body as { error: string }).error], [400, "bad-note"]);
      const closed = await post(port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: opened.revision + 1, status: "no-violation", note: "Within the rules." });
      assert.equal(closed.status, 200, closed.text);
      const stored = (await store.load(caseId)) as ConductCase;
      assert.equal(stored.status, "no-violation");
      assert.deepEqual(stored.history.map((event) => [event.from, event.to, event.note]), [["open", "under-review", "Looking at the turn times."], ["under-review", "no-violation", "Within the rules."]]);
      assert.ok(stored.history.every((event) => /^acct-[0-9a-f]{12}$/.test(event.reviewer)), "the reviewer is a fingerprint in the history");

      /* Ann (the reported account) and Cid (seated at that table) are reviewers too: neither sees the case at all. */
      for (const party of [ann, cid]) {
        assert.equal((await post(port, "/gs/api/profile/reauth", party.cookie, { password: PASSWORD })).status, 200);
        const theirQueue = await post(port, "/gs/api/conduct/review/queue", party.cookie);
        assert.deepEqual((theirQueue.body as { cases: unknown[] }).cases, [], `${party.name}'s queue does not show a case they are a party to`);
        assert.deepEqual((await post(port, "/gs/api/conduct/review/case", party.cookie, { caseId })).status, 404);
        const refused = await post(port, "/gs/api/conduct/review/decide", party.cookie, { caseId, revision: stored.revision, status: "under-review" });
        assert.deepEqual([refused.status, (refused.body as { error: string }).error], [404, "not-found"]);
      }
      assert.equal(((await store.load(caseId)) as ConductCase).revision, stored.revision, "nothing a party sent moved the case");
    } finally {
      await stopServer(server);
    }
  });

  test("a closed body and the usual ingress rules: GET, a foreign Origin, a non-JSON type, an unknown field, an oversized body", async () => {
    const { server, port, browsers } = await prodServer({ reviewers: ["Rita"], accounts: ["Rita"] });
    try {
      const rita = browsers.Rita;
      assert.equal((await apiRequest(port, "/gs/api/conduct/review/queue", { cookie: rita.cookie, method: "GET" })).status, 405);
      assert.equal((await apiRequest(port, "/gs/api/conduct/review/queue", { cookie: rita.cookie, origin: "https://evil.example" })).status, 403);
      assert.equal((await apiRequest(port, "/gs/api/conduct/review/queue", { cookie: rita.cookie, contentType: "text/plain" })).status, 415);
      assert.equal((await post(port, "/gs/api/conduct/review/queue", rita.cookie, { extra: 1 })).status, 400);
      assert.equal((await post(port, "/gs/api/conduct/review/case", rita.cookie, { caseId: 7 })).status, 400);
      assert.equal((await apiRequest(port, "/gs/api/conduct/review/decide", { cookie: rita.cookie, body: `{"caseId":"${"x".repeat(200_000)}"}` })).status, 413);
      assert.equal((await apiRequest(port, "/gs/api/conduct/review/decide", { cookie: rita.cookie, body: '{"__proto__":{"admin":true},"caseId":"x","revision":1,"status":"open"}' })).status, 400);
    } finally {
      await stopServer(server);
    }
  });

  test("a report never moves the reported account's trust facts, and nothing about reports is public", async () => {
    const { server, port } = await prodServer({ reviewers: [] });
    try {
      const ann = await accountBrowser(port, "Ann");
      const ben = await accountBrowser(port, "Ben");
      const cid = await accountBrowser(port, "Cid");
      const table = await prodTable(port, { cookie: ann.cookie, name: "Ann" }, [{ cookie: ben.cookie, name: "Ben" }, { cookie: cid.cookie, name: "Cid" }]);
      const before = await post(port, "/gs/api/trust/me", ann.cookie);
      const viewBefore = table.clients.Ann.of("room").length;
      for (const [who, category] of [["Ben", "harassment"], ["Cid", "collusion"], ["Ben", "stalling"]] as const) {
        assert.equal((await table.clients[who].op({ type: "report-player", playerId: table.ids.Ann, category }, table.gameId)).ok, true);
      }
      const after = await post(port, "/gs/api/trust/me", ann.cookie);
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, before.body, "three reports later, the reported account's facts are identical");
      assert.doesNotMatch(after.text, /report|conduct|"case/i);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(table.clients.Ann.of("room").length, viewBefore, "the reported player's room view did not change");
      assert.doesNotMatch(JSON.stringify(table.clients.Ann.frames), /conduct|report-player|"received"/i, "the reported player is told nothing");
    } finally {
      await stopServer(server);
    }
  });

  test("review status persists: a file store across a server restart; a case whose game is not resident is not re-verified by loading it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-conduct-"));
    try {
      const clock = { now: Date.now() };
      const first = await prodServer({ store: createFileConductCaseStore(dir, { warn: () => undefined }), reviewers: ["Rita"], accounts: ["Ann", "Ben", "Rita"], clock });
      let caseId: string;
      let revision: number;
      try {
        const { Ann: ann, Ben: ben, Rita: rita } = first.browsers;
        const table = await prodTable(first.port, { cookie: ann.cookie, name: "Ann" }, [{ cookie: ben.cookie, name: "Ben" }]);
        assert.equal((await table.clients.Ann.op({ type: "report-player", playerId: table.ids.Ben, category: "offer-spam" }, table.gameId)).ok, true);
        caseId = ((await post(first.port, "/gs/api/conduct/review/queue", rita.cookie)).body as { cases: Array<{ caseId: string }> }).cases[0].caseId;
        const decided = await post(first.port, "/gs/api/conduct/review/decide", rita.cookie, { caseId, revision: 1, status: "escalated", note: "Needs a second reviewer." });
        assert.equal(decided.status, 200, decided.text);
        revision = (decided.body as { case: { revision: number } }).case.revision;
      } finally {
        await stopServer(first.server);
      }
      const reopened = createFileConductCaseStore(dir, { warn: () => undefined });
      const stored = (await reopened.load(caseId)) as ConductCase;
      assert.equal(stored.status, "escalated");
      assert.equal(stored.revision, revision);
      assert.equal(stored.history[0].note, "Needs a second reviewer.");
      assert.doesNotMatch(fs.readFileSync(path.join(dir, "conduct", "cases", `${caseId}.json`), "utf8"), /\b(?:se|sf|rk|pf)_[0-9a-z]|scrypt|password|cookie/, "no session, family, recovery or profile id, and no credential, in the stored case");
      /* A later server (its game NOT resident, no log reader): the case reads, and its pointer is "not re-read here" --
         opening a case never claims or loads a game. */
      const second = await prodServer({ store: reopened, reviewers: ["Rita"], accounts: ["Rita"], clock });
      try {
        const view = await post(second.port, "/gs/api/conduct/review/case", second.browsers.Rita.cookie, { caseId });
        assert.equal(view.status, 200, view.text);
        assert.equal((view.body as { case: { verification: { verified: unknown } } }).case.verification.verified, null);
        assert.equal(second.server.lifecycle !== undefined, true);
      } finally {
        await stopServer(second.server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fresh browser logged in to an existing account (the test password). */
async function loginAgain(port: number, username: string): Promise<string> {
  const before = await bootstrapCookie(port);
  const answer = await apiRequest(port, "/gs/api/account/login", { cookie: before, body: { username, password: PASSWORD } });
  const set = answer.headers["set-cookie"];
  if (answer.status !== 200 || !set) throw new Error(`login: ${answer.status} ${answer.text}`);
  return set[0].split(";")[0];
}

/* ==================================================================
    C. PURE: THE OFFER EXAMPLE, THE POINTER, THE CONFIGURATION, THE BOUNDARY
   ================================================================== */

describe("P3-N035 C: the evidence, the configuration and the boundary", () => {
  const record = {
    record_schema: 1,
    record_version: 9,
    game_id: "g_0000000000000000000000000w",
    join_code: null,
    visibility: "public",
    status: "active",
    archived_at: null,
    host_player_id: "p-aaaaaaaaaaaaaaaa",
    seats: [],
    seat_cap: 6,
    exact_players: null,
    variants: {},
    admitted: [],
    kicked_principals: [],
    turn_order: null,
    rules_engine_version: 13,
    protocol_version: null,
    created_at: 1,
    created_by_principal: "pr_x",
    started_at: 2,
    completed_at: null,
    closed_at: null,
    cancelled_at: null,
    expires_at: null,
    last_activity_at: 3,
    money: null,
    policy: { host_undo: "last-action", private_spectators: false, spectator_chat: false, max_viewers: 50 },
  } as never;
  const A = { player_id: "p-aaaaaaaaaaaaaaaa", principal_id: "pr_a", nickname: "A", joined_at: 1 };
  const B = { player_id: "p-bbbbbbbbbbbbbbbb", principal_id: "pr_b", nickname: "B", joined_at: 2 };
  const entry = (index: number, actor: string, type: string, body: object = {}, at = 1_000 + index * 1_000): ServerLogEntry => ({ index, id: `e${index}`, actor, payload: JSON.stringify({ [type]: body }), at });

  test("the abusive train-offer example: repeated offers after rejection are COUNTED and TIMED, never judged -- one or two offers look like any negotiation", () => {
    const spam: ServerLogEntry[] = [entry(0, "server", "SetupGame")];
    for (let n = 0; n < 6; n += 1) {
      spam.push(entry(spam.length, B.player_id, "ProposeTrainPurchase", { price: 1 }));
      spam.push(entry(spam.length, A.player_id, "AnswerTrainPurchase", { accept: false }));
    }
    spam.push(entry(spam.length, B.player_id, "RescindTrainPurchase"));
    const heavy = deriveEvidence({ record, facts: NO_FACTS, entries: spam, reporter: A, reported: B, chat: null, money: null, clock: null, build: "t", now: 9 });
    assert.deepEqual(heavy.counts.reported, { offers: 6, accepted: 0, declined: 0, rescinded: 1, forgone: 0, undos: 0, passes: 0, actions: 7 });
    assert.deepEqual(heavy.counts.reporter, { offers: 0, accepted: 0, declined: 6, rescinded: 0, forgone: 0, undos: 0, passes: 0, actions: 6 });
    assert.deepEqual(heavy.timeline.slice(1, 3).map((row) => [row.by, row.type, row.outcome ?? null, row.at]), [["reported", "ProposeTrainPurchase", null, 2_000], ["reporter", "AnswerTrainPurchase", "declined", 3_000]]);
    assert.equal(JSON.stringify(heavy).includes('"price"'), false, "no payload (no offer value) is copied: nothing is inferred from values");
    const light = deriveEvidence({ record, facts: NO_FACTS, entries: [entry(0, "server", "SetupGame"), entry(1, B.player_id, "ProposePrivateTrade"), entry(2, A.player_id, "AnswerPrivateTrade", { accept: false })], reporter: A, reported: B, chat: null, money: null, clock: null, build: "t", now: 9 });
    assert.deepEqual([light.counts.reported.offers, light.counts.reporter.declined], [1, 1]);
    assert.equal(Object.keys(heavy).includes("verdict") || Object.keys(heavy).includes("score"), false, "the evidence carries no verdict or score");
  });

  test("caps, budget and races (service): every non-repeat is charged first; the cap counts only the reporter's own reports, whatever a reviewer did; new chat is 'moved on'; a two-tab addition is 'already'", async () => {
    const seat = (who: typeof A) => ({ player_id: who.player_id, principal_id: who.principal_id, binding_epoch: 0, joined_at: who.joined_at, bound_at: who.joined_at, ready: true, nickname: who.nickname, color: null, payout_address: null, chain_seat_index: null });
    const seated = { ...(record as object), seats: [seat(A), seat(B)] } as never;
    let clock = 1_000_000;
    const ops = createMemoryOpsRecorder();
    const fresh = (budget = { capacity: 100, refillPerSecond: 0 }) => {
      const store = createMemoryConductCaseStore();
      const service = createConductService({ store, build: "t", now: () => clock, warn: () => undefined, ops, reporterBudget: budget });
      return { store, service };
    };
    const log: ServerLogEntry[] = [entry(0, "server", "SetupGame")];
    const send = (service: ReturnType<typeof fresh>["service"], over: { chat?: RoomChatEntry[] | null; note?: string } = {}) =>
      service.report({ record: seated, facts: NO_FACTS, entries: [...log], reporterPrincipalId: A.principal_id, reportedPlayerId: B.player_id, category: "harassment", note: over.note ?? null, chat: over.chat ?? [], money: null });
    const grow = () => log.push(entry(log.length, B.player_id, "PassTurn"));

    /* The cap counts the reporter's OWN recorded reports: nine, whether the case stayed open or a reviewer closed it after every report. */
    for (const closeEach of [false, true]) {
      const { store, service } = fresh();
      for (let n = 0; n < MAX_REPORTS_PER_SUBJECT; n += 1) {
        grow();
        const answer = await send(service);
        assert.equal(answer.ok && answer.received, "new", `report ${n + 1} (${closeEach ? "closed after each" : "left open"}): ${JSON.stringify(answer)}`);
        if (closeEach) {
          for (const value of await allCases(store)) {
            if (value.status !== "open") continue;
            const closed = decideCase(value, { expectedRevision: value.revision, to: "no-violation", note: null, reviewerPrincipalId: "pr_r", now: clock });
            if (!("next" in closed)) throw new Error(closed.reason);
            assert.equal((await store.save(closed.next, value.revision)).kind, "committed");
          }
        }
      }
      const kept = await allCases(store);
      assert.equal(kept.reduce((sum, value) => sum + 1 + value.rereports.length, 0), MAX_REPORTS_PER_SUBJECT);
      assert.equal(kept.length, closeEach ? MAX_REPORTS_PER_SUBJECT : 1);
      grow();
      const audited = ops.lines.length;
      const past = await send(service);
      assert.deepEqual(past, { ok: true, received: "capped", message: REPORT_SENTENCES.capped }, "the same answer either way: nothing about the review");
      assert.equal(ops.lines.slice(audited).some((line) => line.event === "conduct.report-capped"), true, "a capped report is recorded in the audit");
      assert.equal((await allCases(store)).length, kept.length);
    }

    /* The budget is spent BEFORE the cap or any write: a capped report costs a token like any other (no free probe). */
    {
      const { service } = fresh({ capacity: MAX_REPORTS_PER_SUBJECT + 1, refillPerSecond: 0 });
      for (let n = 0; n <= MAX_REPORTS_PER_SUBJECT; n += 1) {
        grow();
        assert.equal((await send(service)).ok, true);
      }
      grow();
      const refused = await send(service);
      assert.equal(!refused.ok && refused.code, "rate-limited", "the capped report took the last token");
    }

    /* New chat from either party since the last report is "moved on" (harassment rarely grows the log). */
    {
      const { store, service } = fresh();
      assert.equal((await send(service)).ok, true);
      const quiet = await send(service);
      assert.equal(quiet.ok && quiet.received, "already");
      clock += 1_000;
      const chat: RoomChatEntry[] = [{ id: "c1", author: B.player_id, displayName: "B", text: "abusive line", at: clock }];
      const moved = await send(service, { chat });
      assert.equal(moved.ok && moved.received, "new");
      const [only] = await allCases(store);
      assert.deepEqual(only.rereports[0].chat.map((line) => line.text), ["abusive line"]);
      assert.equal(((await send(service, { chat })) as { received?: string }).received, "already", "the same chat again is nothing new");
    }

    /* Two tabs add the same report on the same revision: the second save is refused, the case read again, and the answer is "already". */
    {
      const { store, service } = fresh();
      assert.equal((await send(service)).ok, true);
      grow();
      const [one, two] = await Promise.all([send(service), send(service)]);
      assert.deepEqual([one, two].map((answer) => (answer.ok ? answer.received : answer.code)).sort(), ["already", "new"]);
      assert.equal((await allCases(store))[0].rereports.length, 1);
    }

    /* An addition the case cannot hold (its byte bound) opens the next case of the sequence -- never a silent drop. */
    {
      const { store, service } = fresh();
      assert.equal((await send(service)).ok, true);
      const [first] = await allCases(store);
      /* Fill the case to within a few bytes of its bound with (valid) chat lines of three-byte characters. */
      const line = (n: number, k = 600) => ({ id: `l${n}`, at: clock, by: "reported" as const, text: "\u20ac".repeat(k) });
      let stuffed: ConductCase = { ...first, evidence: { ...first.evidence, chat: { lines: Array.from({ length: 40 }, (_, n) => line(n)) } } };
      const withLast = (base: ConductCase, lines: ReturnType<typeof line>[]): ConductCase => {
        const rereports = [...base.rereports.slice(0, -1), { ...base.rereports[base.rereports.length - 1], chat: lines }];
        return { ...base, rereports };
      };
      for (let r = 0; r < 6; r += 1) {
        const next: ConductCase = { ...stuffed, revision: stuffed.revision + 1, rereports: [...stuffed.rereports, { at: clock, note: null, log: { captured: true, entries: 1, hash: null }, counts: first.evidence.counts, chat: [] }] };
        if (serializeConductCase(next) === null) break;
        stuffed = next;
        const lines: ReturnType<typeof line>[] = [];
        for (let n = 0; n < 20; n += 1) {
          if (serializeConductCase(withLast(stuffed, [...lines, line(n)])) === null) {
            let lo = 0;
            let hi = 600;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              if (serializeConductCase(withLast(stuffed, [...lines, line(n, mid)])) === null) hi = mid - 1;
              else lo = mid;
            }
            if (lo > 0) lines.push(line(n, lo));
            break;
          }
          lines.push(line(n));
        }
        stuffed = withLast(stuffed, lines);
        if (lines.length < 20) break;
      }
      assert.notEqual(serializeConductCase(stuffed), null, "the stuffed case still fits on its own");
      store.cases.set(first.case_id, stuffed);
      grow();
      const answer = await send(service, { note: "\u20ac".repeat(MAX_REPORT_NOTE_LENGTH) });
      assert.equal(answer.ok && answer.received, "new");
      const cases = await allCases(store);
      assert.deepEqual(cases.map((value) => value.seq).sort(), [0, 1], "a second case, both active");
    }
  });

  test("the log pointer: verified on the same prefix (and after the log grows), refused when the history differs or is shorter", () => {
    const log = [entry(0, A.player_id, "SetupGame"), entry(1, B.player_id, "PassTurn"), entry(2, A.player_id, "PassTurn")];
    const evidence = deriveEvidence({ record, facts: NO_FACTS, entries: log, reporter: A, reported: B, chat: null, money: null, clock: null, build: "t", now: 9 });
    assert.equal(verifyLogPointer(evidence, log).verified, true);
    assert.equal(verifyLogPointer(evidence, [...log, entry(3, B.player_id, "PassTurn")]).verified, true, "an append-only log keeps the pointer valid");
    assert.equal(verifyLogPointer(evidence, [log[0], { ...log[1], payload: JSON.stringify({ PassTurn: { x: 1 } }) }, log[2]]).verified, false);
    assert.equal(verifyLogPointer(evidence, log.slice(0, 2)).verified, false);
  });

  test("the file-mode review reader: the stored log's committed history, read-only (a torn tail's complete batches; a damaged log, a missing one: null; no byte changes)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-conduct-log-"));
    try {
      const gameId = "g_0000000000000000000000000w";
      const writer = createFileLogStore(dir, { warn: () => undefined });
      const log = [entry(0, A.player_id, "SetupGame"), entry(1, B.player_id, "PassTurn")];
      assert.equal((await writer.appendBatch?.(gameId, log))?.kind, "committed");
      const file = path.join(dir, `${gameId}.log.jsonl`);
      const read = await readStoredLogForReview(dir, gameId);
      assert.equal(read?.length, 2);
      assert.equal(logHash(read ?? []), logHash(log));
      fs.appendFileSync(file, '{"torn":');
      const before = fs.readFileSync(file);
      assert.equal((await readStoredLogForReview(dir, gameId))?.length, 2, "a torn tail: the complete batches");
      assert.deepEqual(fs.readFileSync(file), before, "nothing was repaired or written");
      assert.equal(await readStoredLogForReview(dir, "g_0000000000000000000000004w"), null, "no log file");
      assert.equal(await readStoredLogForReview(dir, "../etc"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GS_CONDUCT_REVIEWERS: usernames by their canonical key; anything else refuses the start", () => {
    const parsed = conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: " Rita, BEN  carol " });
    assert.equal(parsed.ok, true);
    assert.deepEqual([...(parsed as { reviewers: ReadonlySet<string> }).reviewers].sort(), ["ben", "carol", "rita"]);
    assert.deepEqual(conductReviewersFromEnv({}), { ok: true, reviewers: new Set() });
    assert.equal(conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: "ok,\u0007bell" }).ok, false);
  });

  test("the boundary: only the conduct module and its wiring touch a case -- trust facts, identity, money and the game engine never read one", () => {
    const root = path.resolve(__dirname, "..", "..", "..", "..", "src");
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) sources.push(full);
      }
    };
    walk(root);
    const allowed = new Set(["conduct", "gameServer.ts", "start.ts", "rooms/roomHost.ts", "aws/runtime/awsRuntime.ts", "aws/runtime/awsMain.ts", "aws/runtime/awsSubstrate.ts", "aws/game/dynamoConductStore.ts", "aws/deploy/deployVerify.ts", "persistence/conformance/subjects.ts", "persistence/conformance/conductStore.conformance.ts"]);
    const offenders: string[] = [];
    for (const file of sources) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (!/from "[^"]*conduct\/(conductStore|conductCase|conductService|conductHttpApi)"/.test(fs.readFileSync(file, "utf8"))) continue;
      if (relative.startsWith("conduct/") || allowed.has(relative)) continue;
      offenders.push(relative);
    }
    assert.deepEqual(offenders, [], "a module outside the reporting lane reads conduct cases");
    for (const file of ["rooms/trustFacts.ts", "rooms/trustHttpApi.ts", "identity/sessions.ts", "escrow/moneyTables.ts"]) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, file), "utf8"), /conduct/i, `${file} knows nothing of conduct reports`);
    }
    /* The room host reaches the service only: it never imports a store, and the service writes the case store alone. */
    assert.doesNotMatch(fs.readFileSync(path.join(root, "rooms", "roomHost.ts"), "utf8"), /conductStore/);
    /* The service and the case model import no store, identity, money, escrow or trust module, and call no writer of
       a game: what they can change is the case store they are handed, and nothing else. */
    for (const name of ["conductService.ts", "conductCase.ts"]) {
      const text = fs.readFileSync(path.join(root, "conduct", name), "utf8");
      const imports = [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const target of imports) {
        assert.doesNotMatch(target, /escrow|identity|money|trust|recordStore|holdStore|fileLogStore|gameActor|roomHost|aws\//, `${name} imports ${target}`);
      }
      for (const call of ["commitRecord", "appendBatch", ".put(", "submit(", "transitionFinancial", "associateWallet"]) {
        assert.equal(text.includes(call), false, `${name} never calls ${call}`);
      }
    }
  });
});
