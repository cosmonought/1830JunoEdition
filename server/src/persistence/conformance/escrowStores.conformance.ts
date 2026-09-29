// server/src/persistence/conformance/escrowStores.conformance.ts
//
// LIVE-5 L5-1: the money layer's game-scoped ports -- the financial record (`FinancialGameStore`: create-if-absent and
// CAS on `record_version`, `conflict` carrying the current record), chain intents (`ChainIntentStore`: create-if-absent
// by `intent_id` with "same subject converges", CAS) and the wallet-ticket ledger (`WalletTicketStore`: one document per
// game, CAS on its version). Every unreadable value -- damage, or another build's format -- is classified and NEVER
// overwritten. Every stale writer is refused, including one whose write is already on its way when the takeover lands.

import assert from "node:assert/strict";

import { FinancialRecordUnreadableError, type FinancialGameStore } from "../../escrow/financialGameStore";
import type { FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { ChainIntentUnreadableError, type ChainIntentStore } from "../../escrow/chainIntents";
import type { WalletTicketStore } from "../../escrow/walletTickets";
import type { Gate } from "./faults";
import { financial, gameId, grant, intent, nextFinancial, nextIntent, ticketDocument } from "./fixtures";
import { hook, rejection, stalledAt, turns, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";
import type { Planted } from "./roomStores.conformance";

const G = gameId(1);
const committed = (outcome: { kind: string }) => assert.equal(outcome.kind, "committed", `expected committed, got ${JSON.stringify(outcome)}`);
const fmt = (what: Planted) => (what === "corrupt" ? "corrupt" : what === "newer" ? "newer" : "older-unread");

/** The hooks every game-scoped escrow subject has (`key`: the game id, or `<game>/<intent>` for intents). */
interface EscrowSubjectHooks {
  /** The stored value for a key, as bytes or item text (`null`: none) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, key: string): Promise<Buffer | string | null>;
  /** "stall-write": hold the key's next write after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext, key: string): Gate;
  /** "inject-lost-answer": the key's next write lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext, key: string): void;
  /** "inject-transient-failure": the key's next write fails before it has any effect. */
  armTransientFailure?(ctx: CaseContext, key: string): void;
}

async function same(subject: EscrowSubjectHooks, ctx: CaseContext, key: string, before: Buffer | string | null): Promise<void> {
  assert.deepEqual(await subject.stored(ctx, key), before, "a refused write leaves the stored value byte-identical");
}

/* ================================================================== */
/*  Financial record                                                   */
/* ================================================================== */

export interface FinancialSubject extends SubjectBase, EscrowSubjectHooks {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<FinancialGameStore>;
  plant?(ctx: CaseContext, gameId: string, what: Planted): Promise<void>;
  /** The next write's first attempt ends UNKNOWN to the writer -- having `landed` or not -- and its resend stalls at the
   *  returned gate (so a takeover can be placed between the attempt and the resend). Needs "inject-lost-answer". */
  armUnknownThenStallResend?(ctx: CaseContext, gameId: string, landed: boolean): Gate;
  /** "idempotency-token": the client request tokens of every write attempt made for this game, in order. */
  writeTokens?(ctx: CaseContext, gameId: string): string[];
}

export const FINANCIAL_CASES: readonly ConformanceCase<FinancialSubject>[] = [
  {
    id: "FIN-01",
    title: "a game with no financial record loads null and is not listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.load(G), null);
      assert.deepEqual(await store.list(), []);
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  {
    id: "FIN-02",
    title: "create at version 1, then read back exactly; it is listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const created = await store.create(financial(1));
      committed(created.outcome);
      assert.equal(created.existing, null);
      assert.deepEqual(await store.load(G), financial(1));
      assert.deepEqual(await store.list(), [G]);
    },
  },
  {
    id: "FIN-03",
    title: "create-if-absent: a repeated creation converges on the first record (returned as existing, nothing overwritten)",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1, ctx.now()))).outcome);
      const before = await subject.stored(ctx, G);
      const again = await store.create(financial(1, ctx.tick(50)));
      committed(again.outcome);
      assert.deepEqual(again.existing, financial(1, ctx.now() - 50));
      assert.deepEqual(await store.load(G), financial(1, ctx.now() - 50));
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "FIN-04",
    title: "update is compare-and-swap on record_version",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const v2 = nextFinancial(financial(1), ctx.tick());
      committed(await store.put(v2, 1));
      assert.deepEqual(await store.load(G), v2);
    },
  },
  {
    id: "FIN-05",
    title: "stale writer: a put naming an old version is a CONFLICT carrying the current record; a missing record is a conflict with null",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.deepEqual(await store.put(nextFinancial(financial(1), ctx.tick()), 1), { kind: "conflict", current: null });
      assert.equal(await subject.stored(ctx, G), null);
      committed((await store.create(financial(1))).outcome);
      const v2 = nextFinancial(financial(1), ctx.tick());
      committed(await store.put(v2, 1));
      const before = await subject.stored(ctx, G);
      assert.deepEqual(await store.put(nextFinancial(financial(1), ctx.tick()), 1), { kind: "conflict", current: v2 });
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "FIN-06",
    title: "a put that does not advance the version by one, or is not a financial record, is DEFINITE; a new record starts at 1",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const before = await subject.stored(ctx, G);
      assert.equal((await store.put({ ...financial(1), record_version: 3 }, 1)).kind, "definite");
      assert.equal((await store.put({ ...nextFinancial(financial(1), ctx.tick()), phase: "nonsense" } as unknown as FinancialGameRecord, 1)).kind, "definite");
      assert.equal((await store.create({ ...financial(2), record_version: 2 })).outcome.kind, "definite");
      assert.equal(await subject.stored(ctx, gameId(2)), null);
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "FIN-07",
    title: "duplicate delivery: the same put delivered twice commits once; the second is a conflict carrying what the first wrote",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const v2 = nextFinancial(financial(1), ctx.tick());
      committed(await store.put(v2, 1));
      assert.deepEqual(await store.put(v2, 1), { kind: "conflict", current: v2 });
    },
  },
  ...(["corrupt", "newer", "older"] as const).map(
    (what): ConformanceCase<FinancialSubject> => ({
      id: `FIN-08-${what}`,
      title: `an unreadable record (${what}) is classified ${fmt(what)} and never overwritten by create or put`,
      needs: ["plant"],
      async run(subject, ctx) {
        await hook(subject.plant, "plant")(ctx, G, what);
        const before = await subject.stored(ctx, G);
        assert.notEqual(before, null);
        const store = await subject.open(ctx);
        const error = await rejection(store.load(G));
        assert.ok(error instanceof FinancialRecordUnreadableError, `expected FinancialRecordUnreadableError, got ${String(error)}`);
        assert.equal(error.format, fmt(what));
        const created = await store.create(financial(1));
        assert.equal(created.outcome.kind, "definite");
        assert.equal(created.existing, null);
        assert.equal((await store.put(nextFinancial(financial(1), ctx.tick()), 1)).kind, "definite");
        await same(subject, ctx, G, before);
      },
    }),
  ),
  {
    id: "FIN-09",
    title: "restart: a reopened store has the record and continues its CAS",
    needs: ["durable"],
    async run(subject, ctx) {
      committed((await (await subject.open(ctx)).create(financial(1))).outcome);
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(G), financial(1));
      committed(await reopened.put(nextFinancial(financial(1), ctx.tick()), 1));
      assert.equal((await (await subject.open(ctx)).load(G))?.record_version, 2);
    },
  },
  {
    id: "FIN-10",
    title: "fence: after a takeover the stale writer's create and put are DEFINITE and write nothing; the new writer continues",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      committed((await stale.create(financial(1))).outcome);
      const before = await subject.stored(ctx, G);
      await ctx.fence.takeOver();
      assert.equal((await stale.put(nextFinancial(financial(1), ctx.tick()), 1)).kind, "definite");
      assert.equal((await stale.create(financial(2))).outcome.kind, "definite");
      await same(subject, ctx, G, before);
      assert.equal(await subject.stored(ctx, gameId(2)), null);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      committed(await current.put(nextFinancial(financial(1), ctx.tick()), 1));
    },
  },
  {
    id: "FIN-11",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its write is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      committed((await stale.create(financial(1))).outcome);
      const before = await subject.stored(ctx, G);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = stale.put(nextFinancial(financial(1), ctx.tick()), 1);
      await stalledAt(stall, pending, "the stale put");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal((await pending).kind, "definite", "FENCE-IN-WRITE: the stale writer's in-flight write was applied");
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "FIN-12",
    title: "idempotent retry: a write whose answer was lost after it landed is settled as committed once -- never a conflict with itself",
    needs: ["inject-lost-answer"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      const v2 = nextFinancial(financial(1), ctx.tick());
      assert.deepEqual(await store.put(v2, 1), { kind: "committed", redone: true });
      assert.deepEqual(await store.load(G), v2);
      assert.deepEqual(await store.put(v2, 1), { kind: "conflict", current: v2 }, "the version moved exactly once");
    },
  },
  {
    id: "FIN-12-token",
    title: "the resend of an unknown outcome carries the SAME client request token as the attempt it repeats",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx, G).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      await store.put(nextFinancial(financial(1), ctx.tick()), 1);
      const attempts = tokens(ctx, G).slice(before);
      assert.equal(attempts.length, 2, `one attempt and one resend (${attempts.length})`);
      assert.equal(attempts[1], attempts[0], "the resend is the identical request");
      assert.match(attempts[0], /^[\x21-\x7e]{1,36}$/, "a ClientRequestToken is 1-36 printable characters");
      await store.put(nextFinancial(nextFinancial(financial(1), 1), ctx.tick()), 2);
      const next = tokens(ctx, G).slice(before + 2);
      assert.equal(next.length, 1);
      assert.notEqual(next[0], attempts[0], "every new attempt has a fresh token");
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<FinancialSubject> => ({
      id: `FIN-12-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: a write that LANDED before a takeover is reported committed (it really is)"
        : "a resend never hides a stale writer: a write that did NOT land before a takeover is refused on resend, never applied",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const store = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        committed((await store.create(financial(1))).outcome);
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, G, landed);
        const v2 = nextFinancial(financial(1), ctx.tick());
        const pending = store.put(v2, 1);
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const stored = await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).load(G);
        if (landed) {
          assert.equal(outcome.kind, "committed");
          assert.deepEqual(stored, v2);
        } else {
          assert.equal(outcome.kind, "definite", `a stale writer's unlanded write must be refused on resend, got ${JSON.stringify(outcome)}`);
          assert.deepEqual(stored, financial(1));
        }
      },
    }),
  ),
  {
    id: "FIN-13",
    title: "transient write failure: DEFINITE, nothing written, and the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const before = await subject.stored(ctx, G);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      const v2 = nextFinancial(financial(1), ctx.tick());
      assert.equal((await store.put(v2, 1)).kind, "definite");
      await same(subject, ctx, G, before);
      committed(await store.put(v2, 1));
    },
  },
  {
    id: "FIN-14",
    title: "ordering under a stall: a later put on the same game never completes before an earlier stalled one",
    needs: ["stall-write", "ordered-under-stall"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      committed((await store.create(financial(1))).outcome);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const v2 = nextFinancial(financial(1), ctx.tick());
      const v3 = nextFinancial(v2, ctx.tick());
      const settled: string[] = [];
      const a = store.put(v2, 1).then((outcome) => settled.push(`v2:${outcome.kind}`));
      await stalledAt(stall, a, "the v2 put");
      const b = store.put(v3, 2).then((outcome) => settled.push(`v3:${outcome.kind}`));
      await turns();
      assert.deepEqual(settled, []);
      stall.release();
      await Promise.all([a, b]);
      assert.deepEqual(settled, ["v2:committed", "v3:committed"]);
    },
  },
  {
    id: "FIN-15",
    title: "listing: every stored game is listed, however many pages the backing store needs",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const ids = Array.from({ length: 23 }, (_, k) => gameId(100 + k));
      for (const [k] of ids.entries()) committed((await store.create(financial(100 + k))).outcome);
      assert.deepEqual([...(await store.list())].sort(), [...ids].sort());
    },
  },
];

/* ================================================================== */
/*  Chain intents                                                      */
/* ================================================================== */

export interface IntentSubject extends SubjectBase, EscrowSubjectHooks {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<ChainIntentStore>;
  /** Place an unreadable intent for (game, intent). */
  plant?(ctx: CaseContext, gameId: string, intentId: string, what: Planted): Promise<void>;
}

const intentKey = (record: { game_id: string; intent_id: string }) => `${record.game_id}/${record.intent_id}`;

export const INTENT_CASES: readonly ConformanceCase<IntentSubject>[] = [
  {
    id: "INT-01",
    title: "nothing stored: load null, the game lists no intents, no game has intents",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.load(G, intent(1, 1).intent_id), null);
      assert.deepEqual(await store.listGame(G), []);
      assert.deepEqual(await store.games(), []);
      assert.equal(await subject.stored(ctx, intentKey(intent(1, 1))), null);
    },
  },
  {
    id: "INT-02",
    title: "create, then read back exactly; the game lists it",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const record = intent(1, 1);
      assert.deepEqual(await store.create(record), { kind: "created", record });
      assert.deepEqual(await store.load(G, record.intent_id), record);
      assert.deepEqual(await store.listGame(G), [record]);
      assert.deepEqual(await store.games(), [G]);
    },
  },
  {
    id: "INT-03",
    title: "create-if-absent: the same subject converges (exists, same); a different message at the slot is exists, NOT same, and the first stands",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const first = intent(1, 1, ctx.now());
      await store.create(first);
      const before = await subject.stored(ctx, intentKey(first));
      assert.deepEqual(await store.create(intent(1, 1, ctx.tick())), { kind: "exists", record: first, same: true });
      const other = intent(1, 1, ctx.tick(), '{"settle":{"other":true}}');
      assert.deepEqual(await store.create(other), { kind: "exists", record: first, same: false });
      assert.deepEqual(await store.load(G, first.intent_id), first);
      await same(subject, ctx, intentKey(first), before);
    },
  },
  {
    id: "INT-04",
    title: "CAS: n+1 over n commits; a stale put is a conflict with the current intent; a missing intent is a conflict with null",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = intent(1, 1);
      assert.deepEqual(await store.put(nextIntent(v1, ctx.tick()), 1), { kind: "conflict", current: null });
      assert.equal(await subject.stored(ctx, intentKey(v1)), null);
      await store.create(v1);
      const v2 = nextIntent(v1, ctx.tick());
      committed(await store.put(v2, 1));
      const before = await subject.stored(ctx, intentKey(v1));
      assert.deepEqual(await store.put(nextIntent(v1, ctx.tick()), 1), { kind: "conflict", current: v2 });
      assert.deepEqual(await store.put(v2, 1), { kind: "conflict", current: v2 }, "duplicate delivery of the same put");
      assert.deepEqual(await store.load(G, v1.intent_id), v2);
      await same(subject, ctx, intentKey(v1), before);
    },
  },
  {
    id: "INT-05",
    title: "a put that does not advance the version by one is DEFINITE; a create that is not version 1 fails and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = intent(1, 1);
      await store.create(v1);
      const before = await subject.stored(ctx, intentKey(v1));
      assert.equal((await store.put({ ...v1, record_version: 3 }, 1)).kind, "definite");
      assert.equal((await store.create({ ...intent(1, 2), record_version: 2 })).kind, "failed");
      assert.equal(await subject.stored(ctx, intentKey(intent(1, 2))), null);
      assert.deepEqual(await store.load(G, v1.intent_id), v1);
      await same(subject, ctx, intentKey(v1), before);
    },
  },
  {
    id: "INT-06",
    title: "ordering: a game's intents list by creation time, then id; games list sorted",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const late = intent(1, 1, ctx.now() + 10);
      const early = intent(1, 2, ctx.now());
      const tieA = intent(1, 3, ctx.now() + 5);
      const tieB = intent(1, 4, ctx.now() + 5);
      for (const record of [late, tieB, early, tieA]) await store.create(record);
      await store.create(intent(3, 1));
      await store.create(intent(2, 1));
      const ties = [tieA, tieB].sort((a, b) => a.intent_id.localeCompare(b.intent_id));
      assert.deepEqual((await store.listGame(G)).map((r) => r.intent_id), [early, ...ties, late].map((r) => r.intent_id));
      assert.deepEqual(await store.games(), [gameId(1), gameId(2), gameId(3)]);
    },
  },
  ...(["corrupt", "newer", "older"] as const).map(
    (what): ConformanceCase<IntentSubject> => ({
      id: `INT-07-${what}`,
      title: `an unreadable intent (${what}) is classified ${fmt(what)}, never overwritten, and fails the game's listing`,
      needs: ["plant"],
      async run(subject, ctx) {
        const record = intent(1, 1);
        await hook(subject.plant, "plant")(ctx, G, record.intent_id, what);
        const before = await subject.stored(ctx, intentKey(record));
        assert.notEqual(before, null);
        const store = await subject.open(ctx);
        const error = await rejection(store.load(G, record.intent_id));
        assert.ok(error instanceof ChainIntentUnreadableError);
        assert.equal(error.format, fmt(what));
        assert.equal((await store.create(record)).kind, "failed");
        assert.equal((await store.put(nextIntent(record, ctx.tick()), 1)).kind, "definite");
        assert.ok((await rejection(store.listGame(G))) instanceof ChainIntentUnreadableError);
        assert.equal(await hook(store.formatOf, "formatOf").call(store, G), fmt(what));
        await same(subject, ctx, intentKey(record), before);
      },
    }),
  ),
  {
    id: "INT-08",
    title: "restart: a reopened store has every intent, and create-if-absent still converges",
    needs: ["durable"],
    async run(subject, ctx) {
      const record = intent(1, 1);
      await (await subject.open(ctx)).create(record);
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.listGame(G), [record]);
      assert.deepEqual(await reopened.create(record), { kind: "exists", record, same: true });
    },
  },
  {
    id: "INT-09",
    title: "fence: after a takeover the stale writer's create fails and its put is DEFINITE; nothing is written",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const v1 = intent(1, 1);
      await stale.create(v1);
      const before = await subject.stored(ctx, intentKey(v1));
      await ctx.fence.takeOver();
      assert.equal((await stale.create(intent(1, 2))).kind, "failed");
      assert.equal((await stale.put(nextIntent(v1, ctx.tick()), 1)).kind, "definite");
      await same(subject, ctx, intentKey(v1), before);
      assert.equal(await subject.stored(ctx, intentKey(intent(1, 2))), null);
    },
  },
  {
    id: "INT-10",
    title: "idempotent retry: a create whose answer was lost after it landed is created once; the retry converges (exists, same)",
    needs: ["inject-lost-answer"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const record = intent(1, 1);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, intentKey(record));
      const first = await store.create(record);
      assert.ok(first.kind === "created" || (first.kind === "exists" && first.same), `a lost answer resolves to created (or converges), got ${JSON.stringify(first)}`);
      assert.deepEqual(await store.create(record), { kind: "exists", record, same: true });
      assert.deepEqual(await store.listGame(G), [record]);
    },
  },
  {
    id: "INT-11",
    title: "transient failure: a create that failed before any effect fails, writes nothing, and the retry creates it",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const record = intent(1, 1);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, intentKey(record));
      assert.equal((await store.create(record)).kind, "failed");
      assert.equal(await subject.stored(ctx, intentKey(record)), null);
      assert.deepEqual(await store.create(record), { kind: "created", record });
    },
  },
  {
    id: "INT-12",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its put is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const v1 = intent(1, 1);
      assert.equal((await stale.create(v1)).kind, "created");
      const before = await subject.stored(ctx, intentKey(v1));
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, intentKey(v1));
      const pending = stale.put(nextIntent(v1, ctx.tick()), 1);
      await stalledAt(stall, pending, "the stale intent put");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal((await pending).kind, "definite", "FENCE-IN-WRITE: the stale writer's in-flight intent put was applied");
      await same(subject, ctx, intentKey(v1), before);
    },
  },
];

/* ================================================================== */
/*  Wallet-ticket ledger                                               */
/* ================================================================== */

export interface TicketSubject extends SubjectBase, EscrowSubjectHooks {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<WalletTicketStore>;
  /** "corrupt": damage; "older": a financial-protocol-2 ledger. */
  plant?(ctx: CaseContext, gameId: string, what: Exclude<Planted, "newer">): Promise<void>;
  /** "inject-unresolved": the next write's replacement fails twice (the redo too): an unresolved outcome. */
  armUnresolvedWrite?(ctx: CaseContext, gameId: string): void;
}

const doc1 = () => ticketDocument([grant(1, 1, 1)]);
const doc2 = () => ticketDocument([{ ...grant(1, 1, 1), revoked_at: 5, revoke_reason: "superseded" }, grant(1, 1, 2)]);
const EMPTY = { version: 0, document: { frozen_at: null, grants: [] } };

export const TICKET_CASES: readonly ConformanceCase<TicketSubject>[] = [
  {
    id: "TKT-01",
    title: "a game with no ledger reads as version 0, empty and not frozen, and is not listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.deepEqual(await store.load(G), EMPTY);
      assert.deepEqual(await hook(store.listGames, "listGames (the security-event hook walks it)").call(store), []);
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  {
    id: "TKT-02",
    title: "the first put (expected 0) commits version 1, read back exactly; the game is listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.put(G, doc1(), 0), "committed");
      assert.deepEqual(await store.load(G), { version: 1, document: doc1() });
      assert.deepEqual(await hook(store.listGames, "listGames").call(store), [G]);
    },
  },
  {
    id: "TKT-03",
    title: "CAS: a put naming the current version commits; a stale or duplicated one is a conflict and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.put(G, doc1(), 0), "committed");
      assert.equal(await store.put(G, doc2(), 1), "committed");
      const before = await subject.stored(ctx, G);
      assert.equal(await store.put(G, doc1(), 1), "conflict");
      assert.equal(await store.put(G, doc2(), 1), "conflict", "duplicate delivery");
      assert.equal(await store.put(G, doc1(), 0), "conflict");
      assert.deepEqual(await store.load(G), { version: 2, document: doc2() });
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "TKT-04",
    title: "restart: a reopened store reads the same version and document",
    needs: ["durable"],
    async run(subject, ctx) {
      assert.equal(await (await subject.open(ctx)).put(G, doc1(), 0), "committed");
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(G), { version: 1, document: doc1() });
      assert.equal(await reopened.put(G, doc2(), 1), "committed");
    },
  },
  {
    id: "TKT-05",
    title: "fence: after a takeover the stale writer's put is refused and writes nothing (F-L5-6 pinned: the port answers `conflict`)",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.equal(await stale.put(G, doc1(), 0), "committed");
      const before = await subject.stored(ctx, G);
      await ctx.fence.takeOver();
      assert.equal(await stale.put(G, doc2(), 1), "conflict");
      await same(subject, ctx, G, before);
    },
  },
  {
    id: "TKT-06",
    title: "a document that breaks the ledger's invariants (two live tickets for one seat) is never written",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const broken = ticketDocument([grant(1, 1, 1), grant(1, 1, 2)]);
      await rejection(store.put(G, broken, 0));
      assert.deepEqual(await store.load(G), EMPTY);
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  ...(["corrupt", "older"] as const).map(
    (what): ConformanceCase<TicketSubject> => ({
      id: `TKT-07-${what}`,
      title: `an unreadable ledger (${what}) fails every read closed and is never overwritten`,
      needs: ["plant"],
      async run(subject, ctx) {
        await hook(subject.plant, "plant")(ctx, G, what);
        const before = await subject.stored(ctx, G);
        assert.notEqual(before, null);
        const store = await subject.open(ctx);
        await rejection(store.load(G));
        await rejection(store.put(G, doc1(), 0));
        await rejection(store.put(G, doc1(), 1));
        assert.equal(await hook(store.formatOf, "formatOf").call(store, G), what === "older" ? "older-unread" : "corrupt");
        await same(subject, ctx, G, before);
      },
    }),
  ),
  {
    id: "TKT-08",
    title: "F-L5-6 pinned: an unresolved write is never answered committed (the port has no `uncertain`: it answers `conflict`), and a re-read sees exactly the old or the new document",
    needs: ["inject-unresolved"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.put(G, doc1(), 0), "committed");
      hook(subject.armUnresolvedWrite, "armUnresolvedWrite")(ctx, G);
      assert.equal(await store.put(G, doc2(), 1), "conflict");
      const after = await (await subject.open(ctx)).load(G);
      assert.ok(
        JSON.stringify(after) === JSON.stringify({ version: 1, document: doc1() }) || JSON.stringify(after) === JSON.stringify({ version: 2, document: doc2() }),
        `a re-read is the old or the new document, never a mixture: ${JSON.stringify(after)}`,
      );
    },
  },
  {
    id: "TKT-09",
    title: "idempotent retry: a put whose answer was lost after it landed is committed once (the version moves by one)",
    needs: ["inject-lost-answer"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.put(G, doc1(), 0), "committed");
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      assert.equal(await store.put(G, doc2(), 1), "committed");
      assert.deepEqual(await store.load(G), { version: 2, document: doc2() });
    },
  },
  {
    id: "TKT-10",
    title: "transient failure: a put that failed before any effect is never answered committed and writes nothing; the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.put(G, doc1(), 0), "committed");
      const before = await subject.stored(ctx, G);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      assert.notEqual(await store.put(G, doc2(), 1), "committed");
      await same(subject, ctx, G, before);
      assert.equal(await store.put(G, doc2(), 1), "committed");
    },
  },
  {
    id: "TKT-11",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its put is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.equal(await stale.put(G, doc1(), 0), "committed");
      const before = await subject.stored(ctx, G);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = stale.put(G, doc2(), 1);
      await stalledAt(stall, pending, "the stale ticket put");
      await ctx.fence.takeOver();
      stall.release();
      assert.notEqual(await pending, "committed", "FENCE-IN-WRITE: the stale writer's in-flight ticket put was applied");
      await same(subject, ctx, G, before);
    },
  },
];
