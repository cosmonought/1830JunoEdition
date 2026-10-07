// server/src/conduct/p3ReportingIntegration.test.ts
//
// ==================================================================
//  CONSOLIDATED FINAL INTEGRATION: PLAYER REPORTING ON THE FINAL ACCOUNT + CLOCK ARCHITECTURE
// ==================================================================
//
// A. THE CROSS-POOL REVIEWER RULE. A reviewer who is (or was) seated at the reported table never handles its case,
//    even when the game is owned by ANOTHER server pool: the party test reads the durable, shared GameRecord (never only
//    this pool's in-memory index) beside the principals the case captured at every report. It survives a restart, a
//    pool handoff and a review answered by another host, and a roster that cannot be read withholds the case (fail
//    closed) instead of reading as "nobody".
// B. THE CLOCK EVIDENCE HOOK. A report carries the table clock's OWN facts -- the final clock lane's evidence events, from
//    its reporting hook and its durable record (window + strike ledger), merged by the lane's sequence number and
//    projected through a whitelist: responsibility, offers, overdue / strikes, cures, votes, pauses, system pauses,
//    finality. Never a signature (or its digest), an approval horizon, a log hash, an authority token or free text. No
//    clock is re-derived by the reporting lane. A clock that moved on (an overdue, a finality) makes a repeat a new
//    report even when the log did not move.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createMemoryRecordStore, type RecordStore } from "../rooms/recordStore";
import { accountBrowser, apiRequest, Client, PROD_ORIGIN, quietConsole, startServer, stopServer, until, type AccountBrowser } from "../rooms/testSupport";
import { createMemoryClockStore } from "../rooms/clock/clockStore";
import { fakeTime } from "../rooms/clock/clockTestSupport";
import { LIVE_ACTION_MS, LIVE_CURE_MS } from "../rooms/clock/clockRecord";
import type { ClockEvidenceEvent } from "../rooms/clock/clockEvidence";
import { conductReviewersFromEnv } from "./conductHttpApi";
import { createMemoryConductCaseStore, type ConductCaseStore } from "./conductStore";
import type { ConductCase } from "./conductCase";
import { parseConductCaseDocument, serializeConductCase } from "./conductCase";
import {
  CONDUCT_CLOCK_BYTES,
  conductClockEvidenceOf,
  conductClockFactOf,
  createConductClockFeed,
  isConductClockEvidence,
  type ConductClockEvidence,
} from "./conductClockFacts";

quietConsole();

const PASSWORD = "correct horse battery";
const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const allCases = async (store: ConductCaseStore): Promise<ConductCase[]> => Promise.all((await store.list()).map(async (id) => (await store.load(id)) as ConductCase));

/** The SAME durable record store as another pool sees it: every record readable, none listed for this pool's startup
 *  index (its ownership claims nothing) -- the game is OWNED elsewhere. `failLoads`: the read is refused (an outage). */
function otherPoolView(shared: RecordStore, over: { failLoads?: boolean } = {}): RecordStore {
  return {
    list: async () => [],
    load: async (gameId) => {
      if (over.failLoads === true) throw new Error("the game table could not be read (injected)");
      return shared.load(gameId);
    },
    put: () => Promise.reject(new Error("another pool never writes this game's record")),
    lookupCode: (code) => shared.lookupCode(code),
    claimCode: () => Promise.reject(new Error("another pool never claims this game's code")),
    releaseCode: () => Promise.resolve(),
  };
}

/* ==================================================================
    A. THE CROSS-POOL REVIEWER RULE
   ================================================================== */

describe("Consolidated integration A: a reviewer seated at the reported table is excluded whichever pool owns the game", () => {
  test("seated AFTER the report, on a game owned by another pool: hidden from the queue, the case and the decision; a restart and a review on another host decide the same; an unreadable roster withholds", async () => {
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const clock = { now: Date.now() };
    const auth = { mode: "production" as const, allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service: identity };
    const shared = createMemoryRecordStore();
    const store = createMemoryConductCaseStore();
    const browsers: Record<string, AccountBrowser> = {};
    /* Pool A: the game's owner. The accounts are made there (identity is shared by every pool). */
    const poolA = await startServer({ identity: auth, records: shared, conduct: { store } });
    let gameId: string;
    try {
      for (const name of ["Ann", "Ben", "Rita", "Vic"]) browsers[name] = await accountBrowser(poolA.port, name);
      const ann = await Client.openWithCookie(poolA.port, browsers.Ann.cookie, "Ann");
      const created = await ann.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Ann" });
      assert.equal(created.ok, true, JSON.stringify(created));
      gameId = (created.data as { gameId: string }).gameId;
      const code = (created.data as { code: string }).code;
      const ben = await Client.openWithCookie(poolA.port, browsers.Ben.cookie, "Ben");
      assert.equal((await ben.op({ type: "join", code, takeSeat: true })).ok, true);
      const annPlayer = (created.data as { playerId: string }).playerId;
      /* Ben reports Ann while Rita is NOT at the table: the case captures only Ann and Ben. */
      const reported = await ben.op({ type: "report-player", playerId: annPlayer, category: "harassment", note: "Insults in the chat." }, gameId);
      assert.equal(reported.ok, true, JSON.stringify(reported));
      const [captured] = await allCases(store);
      const ritaPrincipal = identity.usernameHolder("Rita");
      assert.equal(ritaPrincipal.kind, "active");
      assert.ok(!captured.table_principals.includes((ritaPrincipal as { principalId: string }).principalId), "Rita was not seated at the report");
      /* Rita sits AFTER the report: the durable GameRecord now seats her; the case does not name her. */
      const rita = await Client.openWithCookie(poolA.port, browsers.Rita.cookie, "Rita");
      assert.equal((await rita.op({ type: "join", code, takeSeat: true })).ok, true);
      const record = await shared.load(gameId);
      assert.ok(record?.seats.some((seat) => seat.principal_id === (ritaPrincipal as { principalId: string }).principalId), "the durable record seats Rita");
      await Promise.all([ann.close(), ben.close(), rita.close()]);
    } finally {
      await stopServer(poolA.server);
    }

    const reviewers = conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: "Rita,Vic" });
    if (!reviewers.ok) throw new Error(reviewers.reason);
    /* Pool B: another pool (its index never lists the game), and then the same pool after a restart -- the same answers. */
    for (const label of ["another pool", "another pool, restarted"]) {
      const poolB: Awaited<ReturnType<typeof startServer>> = await startServer({ identity: auth, records: otherPoolView(shared), conduct: { store, reviewers: reviewers.reviewers } });
      try {
        assert.equal(poolB.server.rooms.seatPrincipalsOf(gameId).length, 0, `${label}: this pool's own index knows nothing of the game`);
        for (const name of ["Rita", "Vic"]) assert.equal((await post(poolB.port, "/gs/api/profile/reauth", browsers[name].cookie, { password: PASSWORD })).status, 200);
        const ritaQueue = await post(poolB.port, "/gs/api/conduct/review/queue", browsers.Rita.cookie);
        assert.equal(ritaQueue.status, 200, ritaQueue.text);
        assert.deepEqual((ritaQueue.body as { cases: unknown[] }).cases, [], `${label}: Rita, seated at the table on its durable record, never sees its case`);
        const caseId = (await store.list())[0];
        assert.equal((await post(poolB.port, "/gs/api/conduct/review/case", browsers.Rita.cookie, { caseId })).status, 404);
        const refused = await post(poolB.port, "/gs/api/conduct/review/decide", browsers.Rita.cookie, { caseId, revision: 1, status: "no-violation" });
        assert.deepEqual([refused.status, (refused.body as { error: string }).error], [404, "not-found"], `${label}: Rita cannot decide it`);
        /* Vic, never seated there, reviews it normally. */
        const vicQueue = await post(poolB.port, "/gs/api/conduct/review/queue", browsers.Vic.cookie);
        assert.equal((vicQueue.body as { cases: unknown[] }).cases.length, 1, `${label}: an unconflicted reviewer sees it`);
        assert.equal((await post(poolB.port, "/gs/api/conduct/review/case", browsers.Vic.cookie, { caseId })).status, 200);
      } finally {
        await stopServer(poolB.server);
      }
    }
    assert.equal((await allCases(store))[0].revision, 1, "nothing Rita sent moved the case");

    /* The roster cannot be read (the game table is unavailable): withheld from everyone, never "nobody is seated". */
    const dark = await startServer({ identity: auth, records: otherPoolView(shared, { failLoads: true }), conduct: { store, reviewers: reviewers.reviewers } });
    try {
      assert.equal((await post(dark.port, "/gs/api/profile/reauth", browsers.Vic.cookie, { password: PASSWORD })).status, 200);
      const queue = await post(dark.port, "/gs/api/conduct/review/queue", browsers.Vic.cookie);
      assert.deepEqual([(queue.body as { cases: unknown[] }).cases.length, (queue.body as { unreadable: number }).unreadable], [0, 1], "withheld and counted as not readable now");
      const caseId = (await store.list())[0];
      assert.deepEqual((await post(dark.port, "/gs/api/conduct/review/case", browsers.Vic.cookie, { caseId })).status, 503);
      const decide = await post(dark.port, "/gs/api/conduct/review/decide", browsers.Vic.cookie, { caseId, revision: 1, status: "under-review" });
      assert.deepEqual([decide.status, (decide.body as { error: string }).error], [503, "unavailable"]);
      assert.equal((await allCases(store))[0].revision, 1, "nothing was decided while the roster was unreadable");
    } finally {
      await stopServer(dark.server);
    }
  });

  test("a kicked principal and the table's creator are parties too (both survive in the durable record)", async () => {
    const { createConductService } = await import("./conductService");
    const store = createMemoryConductCaseStore();
    const roster = new Map<string, readonly string[] | null>([["g_0000000000000000000000000w", ["pr_kicked", "pr_creator"]]]);
    const service = createConductService({ store, build: "t", now: () => 1, warn: () => undefined, tableRosterOf: async (gameId) => (roster.has(gameId) ? (roster.get(gameId) as readonly string[] | null) : []) });
    const value = minimalCase("g_0000000000000000000000000w");
    await store.create(value);
    for (const principal of ["pr_kicked", "pr_creator", "pr_reporter", "pr_reported"]) {
      assert.equal((await service.queue(principal)).cases.length, 0, `${principal} is a party`);
    }
    assert.equal((await service.queue("pr_reviewer")).cases.length, 1);
    roster.set("g_0000000000000000000000000w", null);
    const withheld = await service.queue("pr_reviewer");
    assert.deepEqual([withheld.cases.length, withheld.unreadable], [0, 1]);
  });
});

describe("Consolidated integration A (review follow-up): related-case counts never reveal a case the reviewer may not see", () => {
  test("a case at a table the reviewer sits at is left out of another case's related counts; an unreadable roster makes the counts unknown", async () => {
    const { createConductService } = await import("./conductService");
    const store = createMemoryConductCaseStore();
    const T1 = "g_0000000000000000000000000w";
    const T2 = "g_000000000000000000000000r0";
    const rosters = new Map<string, readonly string[] | null>([[T1, []], [T2, ["pr_reviewer"]]]);
    const service = createConductService({ store, build: "t", now: () => 1, warn: () => undefined, tableRosterOf: async (gameId) => (rosters.has(gameId) ? (rosters.get(gameId) as readonly string[] | null) : []) });
    const first = minimalCase(T1);
    const secondOpen = { ...minimalCase(T2), case_id: "cc_" + "b".repeat(32) } as ConductCase;
    const second = { ...secondOpen, status: "conduct-confirmed", revision: 2, history: [{ at: 2, from: "open", to: "conduct-confirmed", note: null, reviewer: "acct-000000000000" }] } as ConductCase;
    await store.create(first);
    await store.create(secondOpen);
    assert.equal((await store.save(second, 1)).kind, "committed");
    const view = await service.caseView(first.case_id, "pr_reviewer", async () => null);
    assert.deepEqual([view?.related.total, view?.related.confirmed, view?.related.known], [0, 0, true], "the case at the reviewer's own table is not counted");
    const other = await service.caseView(first.case_id, "pr_someone_else", async () => null);
    assert.deepEqual([other?.related.total, other?.related.confirmed], [1, 1], "an unconflicted reviewer sees it counted");
    rosters.set(T2, null);
    const unknown = await service.caseView(first.case_id, "pr_someone_else", async () => null);
    assert.equal(unknown?.related.known, false, "a roster that cannot be read leaves the counts incomplete");
  });
});

function minimalCase(gameId: string): ConductCase {
  const party = (id: string, principal: string) => ({ player_id: id, principal_id: principal, nickname: id, joined_at: 1 });
  const counts = { offers: 0, accepted: 0, declined: 0, rescinded: 0, forgone: 0, undos: 0, passes: 0, actions: 0 };
  const value: ConductCase = {
    format: "gs-conduct-case",
    version: 1,
    case_id: "cc_" + "a".repeat(32),
    seq: 0,
    game_id: gameId,
    category: "harassment",
    created_at: 1,
    reporter: party("p-reporter", "pr_reporter"),
    reported: party("p-reported", "pr_reported"),
    table_principals: ["pr_reporter", "pr_reported"],
    note: null,
    evidence: {
      source: "server",
      captured_at: 1,
      server_build: "t",
      rules: { deal_pin: 13, engine: 13 },
      table: { visibility: "public", status: "active", money: false, seats: 2, record_version: 1, created_at: 1, started_at: 1, completed_at: null, closed_at: null, last_activity_at: 1 },
      log: { captured: true, entries: 0, hash: null, window_from: null, window_to: null },
      timeline: [],
      counts: { reporter: counts, reported: counts },
      chat: null,
      money: null,
      clock: null,
      not_captured: [],
    },
    rereports: [],
    revision: 1,
    status: "open",
    history: [],
  } as ConductCase;
  return value;
}

/* ==================================================================
    B. THE CLOCK EVIDENCE HOOK
   ================================================================== */

const ev = (seq: number, kind: ClockEvidenceEvent["kind"], f: ClockEvidenceEvent["f"], at = 1_000 + seq): ClockEvidenceEvent => ({ seq, kind, at, f });
const HEAD = (n: number) => n.toString(16).padStart(64, "0");

describe("Consolidated integration B: the clock lane's evidence in a conduct case (safe, bounded, never re-derived)", () => {
  test("the projection keeps the conduct facts and drops signatures, approval horizons, log hashes and free text", () => {
    const vote = conductClockFactOf(ev(7, "vote", { epoch: 1, id: 2, seat: "p-bob", yes: true, approve_until: 1_900_000_000, signature: "ab".repeat(32) }));
    assert.deepEqual(vote?.f, { epoch: 1, id: 2, seat: "p-bob", yes: true }, "no approval horizon or signature digest");
    const sealed = conductClockFactOf(ev(9, "remedy-sealed", { remedy: 3, seat: "p-ann", strike: 3, epoch: 3, log_len: 40, log_hash: "cd".repeat(32), approvals: ["p-bob:1:" + "ef".repeat(32)], ledger_head: "01".repeat(32), replaces: null, allowance_secs: 1200, overdue_ms: 5, final_ms: 6 }));
    assert.deepEqual(Object.keys(sealed?.f ?? {}).sort(), ["allowance_secs", "epoch", "final_ms", "log_len", "overdue_ms", "remedy", "seat", "strike"]);
    const pause = conductClockFactOf(ev(10, "system-pause", { preserved_at: 5, reason: "another authority's record: aws:g2:pool-b:7:task-9", again: false }));
    assert.deepEqual(pause?.f, { preserved_at: 5, again: false }, "a system pause's free-text reason (it names this server's authority) is dropped");
    const tradeEnd = conductClockFactOf(ev(11, "trade-end", { result: "proposer-deadline", proposer: "p-ann", recipient: "p-bob", offer: "train:p-ann>p-bob", index: 12, declines: 1, waited_ms: 600_000, frozen_ms: 420_000, charged_ms: 180_000, freeze_left_ms: 0 }));
    assert.equal(tradeEnd?.f.freeze_left_ms, 0, "an exhausted offer-freeze budget is a fact the reviewer sees");
    assert.equal(tradeEnd?.f.result, "proposer-deadline");
    assert.equal(conductClockFactOf({ seq: 1.5, kind: "vote", at: 1, f: {} }), null);
    assert.equal(conductClockFactOf({ seq: 1, kind: "unknown-kind" as ClockEvidenceEvent["kind"], at: 1, f: {} }), null);
  });

  test("the feed is bounded per game and across games, keeps one fact per sequence number, and never throws into the clock", () => {
    const feed = createConductClockFeed({ perGame: 4, games: 2 });
    for (let seq = 0; seq < 10; seq += 1) feed.hook({ game_id: "g1", event: ev(seq, "responsibility", { seat: "p-a" }), head: HEAD(seq + 1) });
    assert.deepEqual(feed.recent("g1").map((entry) => entry.fact.seq), [6, 7, 8, 9]);
    feed.hook({ game_id: "g1", event: ev(8, "responsibility", { seat: "p-b" }), head: HEAD(99) });
    assert.deepEqual(feed.recent("g1").map((entry) => [entry.fact.seq, entry.fact.f.seat]), [[6, "p-a"], [7, "p-a"], [8, "p-b"], [9, "p-a"]], "a replayed sequence number replaces, never duplicates");
    feed.hook({ game_id: "g2", event: ev(0, "policy", { deadline: "live" }), head: HEAD(1) });
    feed.hook({ game_id: "g3", event: ev(0, "policy", { deadline: "live" }), head: HEAD(1) });
    assert.equal(feed.recent("g1").length, 0, "the least recently touched game is dropped past the bound");
    assert.doesNotThrow(() => feed.hook({ game_id: "g4", event: null as unknown as ClockEvidenceEvent, head: HEAD(1) }));
  });

  test("a case's clock evidence merges the durable window, the strike ledger and the feed by sequence number, under its byte bound", () => {
    const record = {
      policy: { class: "live", pace_secs: null, frozen_at: 1 },
      strikes: { "p-ann": 2 },
      evidence: {
        seq: 50,
        head: HEAD(50),
        window_from: HEAD(10),
        window: Array.from({ length: 40 }, (_, i) => ev(11 + i, "trade-end", { result: "reject", proposer: "p-ann", recipient: "p-bob", declines: 1, waited_ms: 1_000, frozen_ms: 1_000, charged_ms: 0, freeze_left_ms: 599_000, signature: "zz" })),
        truncated: false,
        ledger_from: HEAD(0),
        ledger_head: HEAD(9),
        ledger: [ev(3, "overdue", { seat: "p-ann", strike: 1, log_hash: "aa".repeat(32) }), ev(5, "cure", { seat: "p-ann", strike: 1 }), ev(8, "overdue", { seat: "p-ann", strike: 2 })],
      },
    } as unknown as Parameters<typeof conductClockEvidenceOf>[0]["record"];
    const recent = [51, 52].map((seq) => ({ fact: conductClockFactOf(ev(seq, "pause-request", { id: 1, kind: "pause", by: "p-bob" })) as NonNullable<ReturnType<typeof conductClockFactOf>>, head: HEAD(seq) }));
    const value = conductClockEvidenceOf({ record, recent }) as ConductClockEvidence;
    assert.equal(isConductClockEvidence(value), true);
    assert.equal(value.record, "read");
    assert.deepEqual([value.seq, value.head], [52, HEAD(52)], "the newest fact known, with the lane's own chain head after it");
    assert.deepEqual(value.ledger.map((fact) => [fact.kind, fact.f.strike]), [["overdue", 1], ["cure", 1], ["overdue", 2]], "the strike ledger first, never trimmed for recent chatter");
    assert.deepEqual(value.strikes, { "p-ann": 2 });
    assert.equal(value.events[value.events.length - 1].seq, 52);
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= CONDUCT_CLOCK_BYTES);
    assert.equal(value.omitted, 42 - value.events.length);
    assert.doesNotMatch(JSON.stringify(value), /signature|log_hash|"zz"/);
    assert.equal(conductClockEvidenceOf({ record: null, recent: [] }), null, "nothing known: not captured");
    /* A SEALED remedy's window (moved out of the live window by the seal) is still read after a restart or a handoff. */
    const sealed = {
      ...(record as object),
      evidence: { ...(record as { evidence: object }).evidence, window: [ev(60, "remedy-status", { remedy: 1, status: "attesting" })], seq: 60, head: HEAD(60) },
      remedy: { evidence: { events: [ev(55, "proposal", { epoch: 2, id: 1, kind: "foreclose", by: "p-bob" }), ev(56, "vote", { epoch: 2, id: 1, seat: "p-bob", yes: true, signature: "aa" }), ev(57, "final", { epoch: 2, seat: "p-ann", outcome: "foreclosure" }), ev(58, "remedy-sealed", { remedy: 2, seat: "p-ann", strike: 2, signature: "x" })], ledger: { from: HEAD(0), events: [ev(52, "overdue", { seat: "p-ann", strike: 2 })] } } },
    } as unknown as Parameters<typeof conductClockEvidenceOf>[0]["record"];
    const afterSeal = conductClockEvidenceOf({ record: sealed, recent: [] }) as ConductClockEvidence;
    assert.deepEqual(afterSeal.events.slice(-5).map((fact) => fact.kind), ["proposal", "vote", "final", "remedy-sealed", "remedy-status"], "the sealed decision's facts are in the case");
    assert.ok(afterSeal.ledger.some((fact) => fact.seq === 52), "the sealed document's ledger too");
    assert.doesNotMatch(JSON.stringify(afterSeal), /signature/);
    const unread = conductClockEvidenceOf({ record: "unreadable", recent }) as ConductClockEvidence;
    assert.deepEqual([unread.record, unread.deadline, unread.events.length], ["unreadable", null, 2]);
  });

  test("through the real server: an overdue's facts are in the stalling report; minute 30's finality makes a repeat a NEW addition though the log never moved; the case stays readable", async () => {
    const time = fakeTime(1_780_000_000_000);
    const store = createMemoryConductCaseStore();
    const clockStore = createMemoryClockStore();
    const { server, port } = await startServer({ records: createMemoryRecordStore(), conduct: { store }, clock: { store: clockStore, authority: "auth-1", now: time.now, timers: time.timers } });
    time.drain = async () => {
      await server.clock?.idle();
    };
    try {
      const host = await Client.open(port, "alice");
      const created = await host.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "alice" });
      assert.equal(created.ok, true, JSON.stringify(created));
      const { gameId, code, playerId: alice } = created.data as { gameId: string; code: string; playerId: string };
      const bob = await Client.open(port, "bob");
      const carol = await Client.open(port, "carol");
      for (const guest of [bob, carol]) assert.equal((await guest.op({ type: "join", code, takeSeat: true })).ok, true);
      for (const client of [host, bob, carol]) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      assert.equal((await host.op({ type: "start-game" }, gameId)).ok, true);
      await until(() => clockStore.clocks.get(gameId) !== undefined, "the table's clock record");
      /* Alice owes the first action and lets it run out: OVERDUE, strike 1. */
      await time.advance(LIVE_ACTION_MS);
      await until(() => {
        const stored = clockStore.clocks.get(gameId);
        return typeof stored === "object" && stored.overdue !== null;
      }, "Alice overdue");
      const first = await bob.op({ type: "report-player", playerId: alice, category: "stalling", note: "Let the clock run out." }, gameId);
      assert.equal(first.ok, true, JSON.stringify(first));
      const [value] = await allCases(store);
      const clock = value.evidence.clock as ConductClockEvidence;
      assert.equal(isConductClockEvidence(clock), true, JSON.stringify(clock));
      assert.deepEqual([clock.record, clock.deadline], ["read", "live"]);
      assert.deepEqual(clock.strikes, { [alice]: 1 }, "the strike as the clock recorded it");
      assert.ok(clock.ledger.some((fact) => fact.kind === "overdue" && fact.f.seat === alice && fact.f.strike === 1), "the overdue strike is in the case");
      assert.ok(clock.events.some((fact) => fact.kind === "responsibility" && fact.f.seat === alice), "who owed the action is in the case");
      const stored = clockStore.clocks.get(gameId) as { evidence: { head: string; seq: number } };
      assert.deepEqual([clock.seq, clock.head], [stored.evidence.seq, stored.evidence.head], "the case names the clock lane's own evidence head");
      assert.doesNotMatch(JSON.stringify(clock), /signature|approve_until|log_hash|auth-1/, "no signature, horizon, log hash or authority token");
      assert.ok(!value.evidence.not_captured.some((line) => /clock/i.test(line)), "the clock WAS captured");

      /* The same report again a moment later, nothing moved: already received. */
      const again = await bob.op({ type: "report-player", playerId: alice, category: "stalling" }, gameId);
      assert.deepEqual([again.ok, (again.data as { received: string }).received], [true, "already"]);
      /* Minute 30: no cure, no vote -- the clock's finality (a neutral timeout annulment). The LOG did not move, but the
         clock did: the repeat is a new addition carrying the finality. */
      await time.advance(LIVE_CURE_MS);
      await until(() => {
        const now = clockStore.clocks.get(gameId);
        return typeof now === "object" && now.ended !== null;
      }, "minute 30's finality");
      const later = await bob.op({ type: "report-player", playerId: alice, category: "stalling", note: "Still nothing; the game ended." }, gameId);
      assert.deepEqual([later.ok, (later.data as { received: string }).received], [true, "new"], JSON.stringify(later));
      const [after] = await allCases(store);
      assert.equal(after.rereports.length, 1);
      const addition = after.rereports[0].clock as ConductClockEvidence;
      assert.ok(addition.events.some((fact) => fact.kind === "final" && fact.f.seat === alice), "the finality is in the addition");
      assert.equal(after.rereports[0].log.entries, value.evidence.log.entries, "the log never moved");
      /* The stored case round-trips through the one parser every store reads with. */
      assert.deepEqual(parseConductCaseDocument(serializeConductCase(after) as string, after.case_id), after);
      await Promise.all([host.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });
});
