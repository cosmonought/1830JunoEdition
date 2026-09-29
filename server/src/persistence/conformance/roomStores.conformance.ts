// server/src/persistence/conformance/roomStores.conformance.ts
//
// LIVE-5 L5-1: the GameRecord port (`RecordStore`: the record with CAS on `record_version`, and the join-code index)
// and the durable-hold port (`HoldStore`: create-if-absent, "the first hold stands", operator-only release).

import assert from "node:assert/strict";

import type { GameRecord } from "../../rooms/gameRecord";
import { HoldUnreadableError, type GameHold, type HoldStore } from "../../rooms/holdStore";
import type { RecordStore } from "../../rooms/recordStore";
import { isStoreCorrupt, isStoreIncompatible, StoreDefiniteError, type StoreWriteOutcome } from "../storeResult";
import type { Gate } from "./faults";
import { gameId, gameRecord, hold, joinCode, nextRecord } from "./fixtures";
import { hook, rejection, sameTokenThenFresh, stalledAt, turns, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

/** What a test can plant where a store keeps one value: damage, or another build's format. */
export type Planted = "corrupt" | "newer" | "older";

/* ================================================================== */
/*  GameRecord + join codes                                            */
/* ================================================================== */

export interface RecordSubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<RecordStore>;
  /** The stored record of a game, as bytes or item text (`null`: none) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, gameId: string): Promise<Buffer | string | null>;
  plant?(ctx: CaseContext, gameId: string, what: Planted): Promise<void>;
  /** "stall-write": hold the game's next record put after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext, gameId: string): Gate;
  /** "inject-lost-answer": the game's next record put lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext, gameId: string): void;
  /** "inject-transient-failure": the game's next record put fails before it has any effect. */
  armTransientFailure?(ctx: CaseContext, gameId: string): void;
  /** "idempotency-token": the client request tokens of every record write attempt for this game, in order. */
  writeTokens?(ctx: CaseContext, gameId: string): string[];
  /** The game's next record put ends UNKNOWN to the writer -- having `landed` or not -- and its resend stalls. */
  armUnknownThenStallResend?(ctx: CaseContext, gameId: string, landed: boolean): Gate;
  /** Hold the next claim of this join code after the writer's own checks, before it is applied. */
  stallNextCodeClaim?(ctx: CaseContext, code: string): Gate;
  /** "inject-unevaluated": the game's next record put (landed or not) and every resend fail unevaluated; reads work. */
  armUnevaluated?(ctx: CaseContext, gameId: string, landed: boolean): void;
}

const G = gameId(1);
const ok = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "committed", `expected committed, got ${JSON.stringify(outcome)}`);
const refusedDefinite = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "definite", `expected definite, got ${JSON.stringify(outcome)}`);

async function recordUnchanged(subject: RecordSubject, ctx: CaseContext, id: string, before: Buffer | string | null) {
  assert.deepEqual(await subject.stored(ctx, id), before, "a refused write leaves the stored record byte-identical");
}

async function refusedOrThrew(write: () => Promise<StoreWriteOutcome>): Promise<void> {
  let outcome: StoreWriteOutcome | null = null;
  try {
    outcome = await write();
  } catch {
    return; // a refusal by rejection: nothing was written (checked by the caller's byte comparison)
  }
  assert.notEqual(outcome.kind, "committed", "an unreadable record is never overwritten");
}

export const RECORD_CASES: readonly ConformanceCase<RecordSubject>[] = [
  {
    id: "REC-01",
    title: "a game never stored loads as null and is not listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.load(G), null);
      assert.deepEqual(await store.list(), []);
    },
  },
  {
    id: "REC-02",
    title: "create (expected null) at version 1, then read it back exactly; it is listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const record = gameRecord(1);
      ok(await store.put(record, null));
      assert.deepEqual(await store.load(G), record);
      assert.deepEqual(await store.list(), [G]);
    },
  },
  {
    id: "REC-03",
    title: "update is compare-and-swap: version n+1 over n commits",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      const v2 = nextRecord(v1, ctx.tick());
      ok(await store.put(v2, 1));
      assert.deepEqual(await store.load(G), v2);
    },
  },
  {
    id: "REC-04",
    title: "stale writer: a put naming an old version, or creating over an existing record, is DEFINITE and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      const v2 = nextRecord(v1, ctx.tick());
      ok(await store.put(v2, 1));
      const before = await subject.stored(ctx, G);
      refusedDefinite(await store.put({ ...v2, last_activity_at: ctx.tick() }, 1));
      refusedDefinite(await store.put(v1, null));
      assert.deepEqual(await store.load(G), v2);
      await recordUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "REC-05",
    title: "a write must advance the version by exactly one (skipping or repeating a version is DEFINITE)",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      refusedDefinite(await store.put({ ...v1, record_version: 3 }, 1));
      refusedDefinite(await store.put({ ...v1, last_activity_at: ctx.tick() }, 1));
      refusedDefinite(await store.put({ ...v1, record_version: 2 }, null));
      assert.deepEqual(await store.load(G), v1);
    },
  },
  {
    id: "REC-06",
    title: "duplicate delivery: a create or an update delivered twice commits once; the second copy is DEFINITE",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      refusedDefinite(await store.put(v1, null));
      const v2 = nextRecord(v1, ctx.tick());
      ok(await store.put(v2, 1));
      refusedDefinite(await store.put(v2, 1));
      assert.equal((await store.load(G))?.record_version, 2);
    },
  },
  {
    id: "REC-07",
    title: "a damaged record is refused CORRUPT and never overwritten",
    needs: ["plant"],
    async run(subject, ctx) {
      await hook(subject.plant, "plant")(ctx, G, "corrupt");
      const before = await subject.stored(ctx, G);
      const store = await subject.open(ctx);
      assert.ok(isStoreCorrupt(await rejection(store.load(G))));
      await refusedOrThrew(() => store.put(gameRecord(1), null));
      await refusedOrThrew(() => store.put(nextRecord(gameRecord(1), ctx.tick()), 1));
      await recordUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "REC-08",
    title: "newer record_schema: INCOMPATIBLE (another build's), never read as damage, never overwritten",
    needs: ["plant"],
    async run(subject, ctx) {
      await hook(subject.plant, "plant")(ctx, G, "newer");
      const before = await subject.stored(ctx, G);
      const store = await subject.open(ctx);
      assert.ok(isStoreIncompatible(await rejection(store.load(G))));
      await refusedOrThrew(() => store.put(nextRecord(gameRecord(1), ctx.tick()), 1));
      await recordUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "REC-09",
    title: "restart: a reopened store loads the record and continues its CAS from the stored version",
    needs: ["durable"],
    async run(subject, ctx) {
      const v1 = gameRecord(1);
      ok(await (await subject.open(ctx)).put(v1, null));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(G), v1);
      refusedDefinite(await reopened.put(v1, null));
      ok(await reopened.put(nextRecord(v1, ctx.tick()), 1));
      assert.equal((await (await subject.open(ctx)).load(G))?.record_version, 2);
    },
  },
  {
    id: "REC-10",
    title: "fence: after a takeover the stale writer's record put is DEFINITE and its code claim refused; nothing is written",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const v1 = gameRecord(1);
      ok(await stale.put(v1, null));
      const before = await subject.stored(ctx, G);
      await ctx.fence.takeOver();
      refusedDefinite(await stale.put(nextRecord(v1, ctx.tick()), 1));
      const claim = await rejection(stale.claimCode(joinCode(2), gameId(2)));
      assert.ok(claim instanceof StoreDefiniteError || (claim as Error).name === "StoreDefiniteError", "a fenced claim is definite");
      refusedDefinite(await stale.put(gameRecord(2), null));
      assert.equal(await subject.stored(ctx, gameId(2)), null, "a stale writer creates no game");
      await recordUnchanged(subject, ctx, G, before);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      ok(await current.put(nextRecord(v1, ctx.tick()), 1));
      assert.equal(await current.lookupCode(joinCode(2)), null);
    },
  },
  {
    id: "REC-11",
    title: "join codes: claim is a conditional insert, idempotent for its own game; release only removes a code that names the game",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const code = joinCode(1);
      assert.equal(await store.claimCode(code, G), "claimed");
      assert.equal(await store.claimCode(code, G), "claimed", "a repeated claim by the same game is idempotent");
      assert.equal(await store.claimCode(code, gameId(2)), "taken");
      assert.equal(await store.lookupCode(code), G);
      await store.releaseCode(code, gameId(2));
      assert.equal(await store.lookupCode(code), G, "another game cannot release it");
      await store.releaseCode(code, G);
      assert.equal(await store.lookupCode(code), null);
      assert.equal(await store.claimCode(code, gameId(2)), "claimed", "a released code can be claimed again");
    },
  },
  {
    id: "REC-12",
    title: "join codes survive a restart",
    needs: ["durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.claimCode(joinCode(1), G), "claimed");
      const reopened = await subject.open(ctx);
      assert.equal(await reopened.lookupCode(joinCode(1)), G);
      assert.equal(await reopened.claimCode(joinCode(1), gameId(2)), "taken");
    },
  },
  {
    id: "REC-13",
    title: "idempotent retry: a put whose answer was lost after it landed is committed once at the new version",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      const v2 = nextRecord(v1, ctx.tick());
      assert.deepEqual(await store.put(v2, 1), { kind: "committed", redone: true });
      assert.deepEqual(await (await subject.open(ctx)).load(G), v2);
      refusedDefinite(await store.put(v2, 1));
    },
  },
  {
    id: "REC-13-token",
    title: "the resend of a record put whose answer was lost carries the SAME client request token; the next put a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx, G).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      const v2 = nextRecord(v1, ctx.tick());
      assert.deepEqual(await store.put(v2, 1), { kind: "committed", redone: true });
      sameTokenThenFresh(tokens(ctx, G).slice(before), 2);
      ok(await store.put(nextRecord(v2, ctx.tick()), 2));
      sameTokenThenFresh(tokens(ctx, G).slice(before), 3);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<RecordSubject> => ({
      id: `REC-13-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: a record put that LANDED before a takeover is reported committed (it really is)"
        : "a resend never hides a stale writer: a record put that did NOT land before a takeover is refused on resend, never applied",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const store = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        const v1 = gameRecord(1);
        ok(await store.put(v1, null));
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, G, landed);
        const v2 = nextRecord(v1, ctx.tick());
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
          assert.equal(outcome.kind, "definite", `a stale writer's unlanded put must be refused on resend, got ${JSON.stringify(outcome)}`);
          assert.deepEqual(stored, v1);
        }
      },
    }),
  ),
  ...([true, false] as const).map(
    (landed): ConformanceCase<RecordSubject> => ({
      id: `REC-20-${landed ? "landed" : "unlanded"}`,
      title: landed
        ? "a record put whose every resend went unevaluated, and which IS stored, is reported committed"
        : "a record put whose every resend went unevaluated, and which is NOT visible, is UNCERTAIN -- never 'nothing was written'",
      needs: ["inject-unevaluated", "durable"],
      async run(subject, ctx) {
        const store = await subject.open(ctx);
        const v1 = gameRecord(1);
        ok(await store.put(v1, null));
        hook(subject.armUnevaluated, "armUnevaluated")(ctx, G, landed);
        const v2 = nextRecord(v1, ctx.tick());
        const outcome = await store.put(v2, 1);
        const stored = await (await subject.open(ctx)).load(G);
        if (landed) {
          assert.deepEqual(outcome, { kind: "committed", redone: true });
          assert.deepEqual(stored, v2);
        } else {
          assert.equal(outcome.kind, "uncertain", JSON.stringify(outcome));
          assert.deepEqual(stored, v1);
        }
      },
    }),
  ),
  {
    id: "REC-21",
    title: "the condition is inside the write: of two creators racing for one game, the second to apply is refused and the first record stands",
    needs: ["cas-in-write", "stall-write"],
    async run(subject, ctx) {
      const first = await subject.open(ctx);
      const second = await subject.open(ctx);
      const mine = gameRecord(1);
      const theirs = { ...gameRecord(1), last_activity_at: mine.last_activity_at + 7 };
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = first.put(mine, null);
      await stalledAt(stall, pending, "the first creator's put");
      ok(await second.put(theirs, null));
      stall.release();
      assert.equal((await pending).kind, "definite", "CAS-IN-WRITE: the first creator's in-flight record overwrote the second's");
      assert.deepEqual(await (await subject.open(ctx)).load(G), theirs);
    },
  },
  {
    id: "REC-14",
    title: "transient write failure before anything is replaced: DEFINITE, nothing written, and the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      const before = await subject.stored(ctx, G);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      const v2 = nextRecord(v1, ctx.tick());
      refusedDefinite(await store.put(v2, 1));
      await recordUnchanged(subject, ctx, G, before);
      ok(await store.put(v2, 1));
    },
  },
  {
    id: "REC-15",
    title: "partial multi-step create: a code claimed and a record put that failed leave an orphan that resolves to no game",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const code = joinCode(1);
      assert.equal(await store.claimCode(code, G), "claimed");
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      refusedDefinite(await store.put(gameRecord(1), null));
      assert.equal(await store.lookupCode(code), G, "the orphan index entry stays (harmless)");
      assert.equal(await store.load(G), null, "and names no record: every lookup is checked against the record");
      ok(await store.put(gameRecord(1), null));
    },
  },
  {
    id: "REC-16",
    title: "ordering under a stall: a later put on the same game never completes before an earlier stalled one",
    needs: ["stall-write", "ordered-under-stall"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const v1 = gameRecord(1);
      ok(await store.put(v1, null));
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const v2 = nextRecord(v1, ctx.tick());
      const v3 = nextRecord(v2, ctx.tick());
      const settled: string[] = [];
      const second = store.put(v2, 1).then((outcome) => settled.push(`v2:${outcome.kind}`));
      await stalledAt(stall, second, "the v2 put");
      const third = store.put(v3, 2).then((outcome) => settled.push(`v3:${outcome.kind}`));
      await turns();
      assert.deepEqual(settled, []);
      stall.release();
      await Promise.all([second, third]);
      assert.deepEqual(settled, ["v2:committed", "v3:committed"]);
      assert.equal((await store.load(G))?.record_version, 3);
    },
  },
  {
    id: "REC-18",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its put is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const v1 = gameRecord(1);
      ok(await stale.put(v1, null));
      const before = await subject.stored(ctx, G);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = stale.put(nextRecord(v1, ctx.tick()), 1);
      await stalledAt(stall, pending, "the stale put");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal((await pending).kind, "definite", "FENCE-IN-WRITE: the stale writer's in-flight put was applied");
      await recordUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "REC-19",
    title: "fence inside the write (join code): a takeover after the stale writer's own checks, before its code claim is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const code = joinCode(4);
      const stall = hook(subject.stallNextCodeClaim, "stallNextCodeClaim")(ctx, code);
      const pending = stale.claimCode(code, G);
      await stalledAt(stall, pending, "the stale code claim");
      await ctx.fence.takeOver();
      stall.release();
      const outcome = await pending.then(
        (claimed) => claimed,
        (error: unknown) => error,
      );
      assert.ok(outcome instanceof StoreDefiniteError || (outcome as Error)?.name === "StoreDefiniteError", `FENCE-IN-WRITE: the stale writer's in-flight code claim was applied (${String(outcome)})`);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.equal(await current.lookupCode(code), null);
      assert.equal(await current.claimCode(code, gameId(2)), "claimed", "the code is still free for the current writer");
    },
  },
  {
    id: "REC-17",
    title: "index reconciliation: missing codes are added, codes pointing elsewhere re-pointed, orphans kept",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const reconcile = hook(store.reconcileIndex, "reconcileIndex").bind(store);
      assert.equal(await store.claimCode(joinCode(1), gameId(9)), "claimed");
      assert.equal(await store.claimCode(joinCode(3), gameId(3)), "claimed");
      const result = await reconcile(new Map([[joinCode(1), G], [joinCode(2), gameId(2)]]));
      assert.equal(result.outcome.kind, "committed");
      assert.deepEqual([result.added, result.repointed, result.orphans], [1, 1, 1]);
      assert.equal(await store.lookupCode(joinCode(1)), G);
      assert.equal(await store.lookupCode(joinCode(2)), gameId(2));
      assert.equal(await store.lookupCode(joinCode(3)), gameId(3));
    },
  },
];

/* ================================================================== */
/*  Holds                                                              */
/* ================================================================== */

export interface HoldSubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<HoldStore>;
  /** The live hold of a game, as bytes or item text (`null`: none) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, gameId: string): Promise<Buffer | string | null>;
  /** How many released copies of this game's holds are kept (evidence is never deleted). */
  releasedCopies(ctx: CaseContext, gameId: string): Promise<number>;
  plant?(ctx: CaseContext, gameId: string, what: Planted): Promise<void>;
  /** "stall-write": hold the game's next hold create after the writer's own checks, before it is applied. */
  stallNextWrite?(ctx: CaseContext, gameId: string): Gate;
  /** "inject-lost-answer": the game's next hold create lands, and its answer is lost. */
  armLostAnswer?(ctx: CaseContext, gameId: string): void;
  /** "inject-transient-failure": the game's next hold create fails before it has any effect. */
  armTransientFailure?(ctx: CaseContext, gameId: string): void;
  /** "fs-faults": the live hold's path (release's multi-step boundary is a file concern). */
  holdPath?(ctx: CaseContext, gameId: string): string;
  /** "idempotency-token": the client request tokens of every hold write attempt for this game, in order. */
  writeTokens?(ctx: CaseContext, gameId: string): string[];
  /** The game's next hold create ends UNKNOWN to the writer -- having `landed` or not -- and its resend stalls. */
  armUnknownThenStallResend?(ctx: CaseContext, gameId: string, landed: boolean): Gate;
  /** Hold the game's next hold RELEASE after the writer's own checks, before it is applied. */
  stallNextRelease?(ctx: CaseContext, gameId: string): Gate;
  /** "inject-unevaluated": the game's next hold write -- create or release -- (landed or not) and every resend fail
   *  unevaluated; reads work. */
  armUnevaluated?(ctx: CaseContext, gameId: string, landed: boolean): void;
}

const release = (ctx: CaseContext) => ({ released_at: ctx.tick(), note: "verified clean by the conformance suite", verification: { class: "clean", entries: 3, log_hash: null }, build: "conformance" });

async function holdUnchanged(subject: HoldSubject, ctx: CaseContext, id: string, before: Buffer | string | null) {
  assert.deepEqual(await subject.stored(ctx, id), before, "the stored hold is byte-identical");
}

export const HOLD_CASES: readonly ConformanceCase<HoldSubject>[] = [
  {
    id: "HOLD-01",
    title: "a game with no hold loads null and is not listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.load(G), null);
      assert.deepEqual(await store.list(), []);
    },
  },
  {
    id: "HOLD-02",
    title: "create, then read back exactly; the game is listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const created = await store.create(hold(1));
      assert.deepEqual(created, { outcome: { kind: "committed", redone: false }, existing: null });
      assert.deepEqual(await store.load(G), hold(1));
      assert.deepEqual(await store.list(), [G]);
    },
  },
  {
    id: "HOLD-03",
    title: "create-if-absent: the first hold stands; a later detection is answered with it and changes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.create(hold(1, "log-corrupt", ctx.now()));
      const before = await subject.stored(ctx, G);
      const second = await store.create(hold(1, "record-ahead-of-log", ctx.tick(), "a later detection"));
      assert.equal(second.outcome.kind, "committed");
      assert.deepEqual(second.existing, hold(1, "log-corrupt", ctx.now() - 1));
      assert.equal((await store.load(G))?.code, "log-corrupt");
      await holdUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "HOLD-04",
    title: "release moves the hold to evidence: the game is no longer held, and a second release is DEFINITE",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.create(hold(1));
      assert.equal((await store.release(G, release(ctx))).kind, "committed");
      assert.equal(await store.load(G), null);
      assert.deepEqual(await store.list(), []);
      assert.equal((await store.release(G, release(ctx))).kind, "definite");
      assert.equal(await subject.releasedCopies(ctx, G), 1, "the released hold is kept as evidence");
    },
  },
  {
    id: "HOLD-05",
    title: "an unreadable hold HOLDS: load refuses, it is listed, create keeps it untouched, release refuses",
    needs: ["plant"],
    async run(subject, ctx) {
      await hook(subject.plant, "plant")(ctx, G, "corrupt");
      const before = await subject.stored(ctx, G);
      const store = await subject.open(ctx);
      assert.ok((await rejection(store.load(G))) instanceof HoldUnreadableError);
      assert.deepEqual(await store.list(), [G]);
      assert.deepEqual(await store.create(hold(1)), { outcome: { kind: "committed", redone: false }, existing: null });
      assert.equal((await store.release(G, release(ctx))).kind, "definite");
      await holdUnchanged(subject, ctx, G, before);
    },
  },
  {
    id: "HOLD-06",
    title: "restart: a reopened store still holds the game with the first hold",
    needs: ["durable"],
    async run(subject, ctx) {
      await (await subject.open(ctx)).create(hold(1));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(G), hold(1));
      assert.deepEqual((await reopened.create(hold(1, "roster-mismatch"))).existing, hold(1));
    },
  },
  {
    id: "HOLD-07",
    title: "fence: after a takeover the stale writer's create and release are DEFINITE and write nothing",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      await stale.create(hold(1));
      const before = await subject.stored(ctx, G);
      await ctx.fence.takeOver();
      assert.equal((await stale.create(hold(2))).outcome.kind, "definite");
      assert.equal((await stale.release(G, release(ctx))).kind, "definite");
      await holdUnchanged(subject, ctx, G, before);
      assert.equal(await subject.stored(ctx, gameId(2)), null);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.equal(await current.load(gameId(2)), null);
      assert.deepEqual(await current.load(G), hold(1));
    },
  },
  {
    id: "HOLD-08",
    title: "file store: a partial release (evidence written, live hold not removed) is UNCERTAIN and still held; running it again completes it",
    needs: ["fs-faults"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      await store.create(hold(1));
      const live = hook(subject.holdPath, "holdPath")(ctx, G);
      ctx.faults.add({ op: "unlink", where: (at) => at === live, action: { kind: "fail" }, label: "the live hold cannot be removed" });
      assert.equal((await store.release(G, release(ctx))).kind, "uncertain");
      assert.deepEqual(await store.load(G), hold(1), "still held: a release is never half-applied in the game's favour");
      assert.equal((await store.release(G, release(ctx))).kind, "committed");
      assert.equal(await store.load(G), null);
    },
  },
  {
    id: "HOLD-09",
    title: "a value that is not a hold is refused DEFINITE",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const bogus = { ...hold(1), code: "not-a-code" } as unknown as GameHold;
      assert.equal((await store.create(bogus)).outcome.kind, "definite");
      assert.equal(await store.load(G), null);
    },
  },
  {
    id: "HOLD-10",
    title: "idempotent retry: a hold whose answer was lost after it landed is held once, with the first hold",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      assert.deepEqual((await store.create(hold(1))).outcome, { kind: "committed", redone: true });
      assert.deepEqual(await (await subject.open(ctx)).load(G), hold(1));
    },
  },
  {
    id: "HOLD-10-token",
    title: "the resend of a hold create whose answer was lost carries the SAME client request token; the release a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx, G).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      assert.deepEqual((await store.create(hold(1))).outcome, { kind: "committed", redone: true });
      sameTokenThenFresh(tokens(ctx, G).slice(before), 2);
      assert.equal((await store.release(G, release(ctx))).kind, "committed");
      sameTokenThenFresh(tokens(ctx, G).slice(before), 3);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<HoldSubject> => ({
      id: `HOLD-10-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: a hold that LANDED before a takeover is reported committed (it really is)"
        : "a resend never hides a stale writer: a hold that did NOT land before a takeover is refused on resend, never applied",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const store = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, G, landed);
        const pending = store.create(hold(1));
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = (await pending).outcome;
        const stored = await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).load(G);
        if (landed) {
          assert.equal(outcome.kind, "committed");
          assert.deepEqual(stored, hold(1));
        } else {
          assert.equal(outcome.kind, "definite", `a stale writer's unlanded hold must be refused on resend, got ${JSON.stringify(outcome)}`);
          assert.equal(stored, null);
        }
      },
    }),
  ),
  ...([true, false] as const).map(
    (landed): ConformanceCase<HoldSubject> => ({
      id: `HOLD-14-${landed ? "landed" : "unlanded"}`,
      title: landed
        ? "a hold create whose every resend went unevaluated, and which IS stored, is reported committed"
        : "a hold create whose every resend went unevaluated, and which is NOT visible, is UNCERTAIN -- never 'nothing was written'",
      needs: ["inject-unevaluated", "durable"],
      async run(subject, ctx) {
        const store = await subject.open(ctx);
        hook(subject.armUnevaluated, "armUnevaluated")(ctx, G, landed);
        const outcome = (await store.create(hold(1))).outcome;
        const stored = await (await subject.open(ctx)).load(G);
        if (landed) {
          assert.deepEqual(outcome, { kind: "committed", redone: true });
          assert.deepEqual(stored, hold(1));
        } else {
          assert.equal(outcome.kind, "uncertain", JSON.stringify(outcome));
          assert.equal(stored, null);
        }
      },
    }),
  ),
  ...([true, false] as const).map(
    (landed): ConformanceCase<HoldSubject> => ({
      id: `HOLD-15-${landed ? "landed" : "unlanded"}`,
      title: landed
        ? "a release whose every resend went unevaluated, and which IS applied, is reported committed"
        : "a release whose every resend went unevaluated, and which is NOT visible, is UNCERTAIN -- and the game is still held",
      needs: ["inject-unevaluated", "durable"],
      async run(subject, ctx) {
        const store = await subject.open(ctx);
        assert.equal((await store.create(hold(1))).outcome.kind, "committed");
        hook(subject.armUnevaluated, "armUnevaluated")(ctx, G, landed);
        const outcome = await store.release(G, release(ctx));
        const stored = await (await subject.open(ctx)).load(G);
        if (landed) {
          assert.deepEqual(outcome, { kind: "committed", redone: true });
          assert.equal(stored, null);
          assert.equal(await subject.releasedCopies(ctx, G), 1);
        } else {
          assert.equal(outcome.kind, "uncertain", JSON.stringify(outcome));
          assert.deepEqual(stored, hold(1), "still held");
        }
      },
    }),
  ),
  {
    id: "HOLD-16",
    title: "the condition is inside the write: of two holds racing for one game, the second to apply is refused -- the first hold stands",
    needs: ["cas-in-write", "stall-write"],
    async run(subject, ctx) {
      const first = await subject.open(ctx);
      const second = await subject.open(ctx);
      const mine = hold(1, "log-corrupt", ctx.now(), "the first detection");
      const theirs = hold(1, "record-ahead-of-log", ctx.tick(), "the second detection");
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = first.create(mine);
      await stalledAt(stall, pending, "the first hold create");
      assert.deepEqual(await second.create(theirs), { outcome: { kind: "committed", redone: false }, existing: null });
      stall.release();
      const answer = await pending;
      assert.deepEqual(await (await subject.open(ctx)).load(G), theirs, "CAS-IN-WRITE: the first writer's in-flight hold overwrote the hold that stood");
      assert.deepEqual(answer, { outcome: { kind: "committed", redone: false }, existing: theirs }, "the late create is answered with the hold that stands");
    },
  },
  {
    id: "HOLD-11",
    title: "transient failure: a hold create that failed before any effect is DEFINITE, writes nothing, and the retry holds",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      assert.equal((await store.create(hold(1))).outcome.kind, "definite");
      assert.equal(await subject.stored(ctx, G), null);
      assert.equal((await store.create(hold(1))).outcome.kind, "committed");
      assert.deepEqual(await store.load(G), hold(1));
    },
  },
  {
    id: "HOLD-12",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its hold is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = stale.create(hold(1));
      await stalledAt(stall, pending, "the stale hold create");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal((await pending).outcome.kind, "definite", "FENCE-IN-WRITE: the stale writer's in-flight hold was applied");
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  {
    id: "HOLD-13",
    title: "fence inside the write (release): a takeover after the stale writer's own checks, before its release is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.equal((await stale.create(hold(1))).outcome.kind, "committed");
      const before = await subject.stored(ctx, G);
      const stall = hook(subject.stallNextRelease, "stallNextRelease")(ctx, G);
      const pending = stale.release(G, release(ctx));
      await stalledAt(stall, pending, "the stale release");
      await ctx.fence.takeOver();
      stall.release();
      assert.equal((await pending).kind, "definite", "FENCE-IN-WRITE: the stale writer's in-flight hold release was applied");
      await holdUnchanged(subject, ctx, G, before);
      assert.equal(await subject.releasedCopies(ctx, G), 0, "no released copy was written");
      assert.deepEqual(await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).load(G), hold(1), "the game is still held");
    },
  },
];

export type { GameRecord };
