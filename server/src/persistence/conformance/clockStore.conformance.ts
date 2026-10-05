// server/src/persistence/conformance/clockStore.conformance.ts
//
// PHASE 3 LANE A (AUD-11.04): the gameplay clock's port (`ClockStore`: one record per table, CONDITIONAL on its revision)
// as a behavioural suite every implementation runs -- memory and file here (`clockStore.conformance.test.ts`), DynamoDB
// in `dynamoGame.conformance.test.ts` against DynamoDB Local. The clock is control-plane: a refused or unknown write costs
// the clock (the keeper rereads), never a move -- but the store must still never overwrite a clock it cannot read, never
// let a stale writer through, and never call an unknown outcome "nothing was written".

import assert from "node:assert/strict";

import { ClockUnreadableError, newClockRecord, observeFacts, type ClockFacts, type ClockStore, type GameClockRecord } from "../../rooms/gameClock";
import type { StoreWriteOutcome } from "../storeResult";
import type { Gate } from "./faults";
import { gameId } from "./fixtures";
import { hook, rejection, sameTokenThenFresh, stalledAt, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

export interface ClockSubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<ClockStore>;
  /** The stored clock of a game, as bytes or item text (`null`: none) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, gameId: string): Promise<Buffer | string | null>;
  /** "corrupt": damage; "newer": a newer build's clock format. */
  plant?(ctx: CaseContext, gameId: string, what: "corrupt" | "newer"): Promise<void>;
  stallNextWrite?(ctx: CaseContext, gameId: string): Gate;
  armLostAnswer?(ctx: CaseContext, gameId: string): void;
  armTransientFailure?(ctx: CaseContext, gameId: string): void;
  writeTokens?(ctx: CaseContext, gameId: string): string[];
  armUnknownThenStallResend?(ctx: CaseContext, gameId: string, landed: boolean): Gate;
  armUnevaluated?(ctx: CaseContext, gameId: string, landed: boolean): void;
}

const G = gameId(1);
const POLICY = { live: { turnAllowanceMs: 120_000 }, async: { turnAllowanceMs: null } } as const;

function facts(seat: string, n: number): ClockFacts {
  return { dealt: true, ended: false, closed: false, seat, turnKey: `StockRound|1.0.-1|${seat}`, watermark: n, lastAt: 1_000 + n, undo: null, lastForeignIndex: n - 1, handoverAt: 1_000 + n };
}

/** The first clock of `G` (revision 2: created, then its first turn), and the next one (a turn change). */
function first(ctx: CaseContext): GameClockRecord {
  return observeFacts(newClockRecord(G, "live", POLICY, ctx.now()), facts("p-alice", 0), ctx.now(), ctx.now()).record;
}
function next(record: GameClockRecord, ctx: CaseContext): GameClockRecord {
  const at = ctx.tick(30_000);
  return observeFacts(record, facts(record.turn?.seat === "p-alice" ? "p-bob" : "p-alice", (record.turn?.from_index ?? 0) + 1), at, at).record;
}

const ok = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "committed", `expected committed, got ${JSON.stringify(outcome)}`);
const definite = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "definite", `expected definite, got ${JSON.stringify(outcome)}`);

async function unchanged(subject: ClockSubject, ctx: CaseContext, before: Buffer | string | null) {
  assert.deepEqual(await subject.stored(ctx, G), before, "a refused write leaves the stored clock byte-identical");
}

export const CLOCK_CASES: readonly ConformanceCase<ClockSubject>[] = [
  {
    id: "CLK-01",
    title: "a game with no clock loads null",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.equal(await store.load(G), null);
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  {
    id: "CLK-02",
    title: "the first save (expected none) commits and reads back exactly",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const record = first(ctx);
      ok(await store.save(record, null));
      assert.deepEqual(await store.load(G), record);
    },
  },
  {
    id: "CLK-03",
    title: "CAS on the revision: the current one commits; a stale, absent or duplicated expectation is DEFINITE and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = first(ctx);
      ok(await store.save(r1, null));
      const r2 = next(r1, ctx);
      ok(await store.save(r2, r1.revision));
      const before = await subject.stored(ctx, G);
      definite(await store.save(next(r2, ctx), r1.revision));
      definite(await store.save(r2, r1.revision));
      definite(await store.save(r1, null));
      assert.deepEqual(await store.load(G), r2);
      await unchanged(subject, ctx, before);
    },
  },
  {
    id: "CLK-04",
    title: "restart: a reopened store reads the same clock and continues it",
    needs: ["durable"],
    async run(subject, ctx) {
      const r1 = first(ctx);
      ok(await (await subject.open(ctx)).save(r1, null));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(G), r1);
      ok(await reopened.save(next(r1, ctx), r1.revision));
    },
  },
  {
    id: "CLK-05",
    title: "fence: after a takeover the stale writer's save is DEFINITE and writes nothing; the newer writer continues",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const r1 = first(ctx);
      ok(await stale.save(r1, null));
      const before = await subject.stored(ctx, G);
      await ctx.fence.takeOver();
      definite(await stale.save(next(r1, ctx), r1.revision));
      await unchanged(subject, ctx, before);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.deepEqual(await current.load(G), r1);
      ok(await current.save(next(r1, ctx), r1.revision));
    },
  },
  {
    id: "CLK-06",
    title: "a value that is not a clock record is refused DEFINITE and writes nothing",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const bogus = { ...first(ctx), revision: 0 } as GameClockRecord;
      definite(await store.save(bogus, null));
      assert.equal(await subject.stored(ctx, G), null);
    },
  },
  ...(["corrupt", "newer"] as const).map(
    (what): ConformanceCase<ClockSubject> => ({
      id: `CLK-07-${what}`,
      title: `an unreadable clock (${what}) fails its read with ClockUnreadableError and is never overwritten`,
      needs: ["plant"],
      async run(subject, ctx) {
        await hook(subject.plant, "plant")(ctx, G, what);
        const before = await subject.stored(ctx, G);
        assert.notEqual(before, null);
        const store = await subject.open(ctx);
        const error = await rejection(store.load(G));
        assert.ok(error instanceof ClockUnreadableError, String(error));
        assert.equal((error as ClockUnreadableError).newer, what === "newer");
        definite(await store.save(first(ctx), null));
        definite(await store.save(first(ctx), 1));
        await unchanged(subject, ctx, before);
      },
    }),
  ),
  {
    id: "CLK-08",
    title: "idempotent retry: a save whose answer was lost after it landed is committed once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = first(ctx);
      ok(await store.save(r1, null));
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      const r2 = next(r1, ctx);
      ok(await store.save(r2, r1.revision));
      assert.deepEqual(await (await subject.open(ctx)).load(G), r2);
    },
  },
  {
    id: "CLK-08-token",
    title: "the resend of a clock save whose answer was lost carries the SAME client request token; the next save a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = first(ctx);
      ok(await store.save(r1, null));
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx, G).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, G);
      const r2 = next(r1, ctx);
      ok(await store.save(r2, r1.revision));
      sameTokenThenFresh(tokens(ctx, G).slice(before), 2);
      ok(await store.save(next(r2, ctx), r2.revision));
      sameTokenThenFresh(tokens(ctx, G).slice(before), 3);
    },
  },
  {
    id: "CLK-09",
    title: "transient failure before any effect: never committed, writes nothing; the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = first(ctx);
      ok(await store.save(r1, null));
      const before = await subject.stored(ctx, G);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, G);
      const r2 = next(r1, ctx);
      definite(await store.save(r2, r1.revision));
      await unchanged(subject, ctx, before);
      ok(await store.save(r2, r1.revision));
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<ClockSubject> => ({
      id: `CLK-10-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: a clock save that LANDED before a takeover is reported committed (it really is)"
        : "a resend never hides a stale writer: a clock save that did NOT land before a takeover is refused on resend, never applied",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const store = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        const r1 = first(ctx);
        ok(await store.save(r1, null));
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, G, landed);
        const r2 = next(r1, ctx);
        const pending = store.save(r2, r1.revision);
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const stored = await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).load(G);
        if (landed) {
          ok(outcome);
          assert.deepEqual(stored, r2);
        } else {
          definite(outcome);
          assert.deepEqual(stored, r1);
        }
      },
    }),
  ),
  {
    id: "CLK-11",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its save is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const r1 = first(ctx);
      ok(await stale.save(r1, null));
      const before = await subject.stored(ctx, G);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = stale.save(next(r1, ctx), r1.revision);
      await stalledAt(stall, pending, "the stale clock save");
      await ctx.fence.takeOver();
      stall.release();
      definite(await pending);
      await unchanged(subject, ctx, before);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<ClockSubject> => ({
      id: `CLK-12-${landed ? "landed" : "unlanded"}`,
      title: landed
        ? "a clock save whose every resend went unevaluated, and which IS stored, is reported committed"
        : "a clock save whose every resend went unevaluated, and which is NOT visible, is UNCERTAIN -- never 'nothing was written'",
      needs: ["inject-unevaluated", "durable"],
      async run(subject, ctx) {
        const store = await subject.open(ctx);
        const r1 = first(ctx);
        ok(await store.save(r1, null));
        hook(subject.armUnevaluated, "armUnevaluated")(ctx, G, landed);
        const r2 = next(r1, ctx);
        const outcome = await store.save(r2, r1.revision);
        const stored = await (await subject.open(ctx)).load(G);
        if (landed) {
          ok(outcome);
          assert.deepEqual(stored, r2);
        } else {
          assert.equal(outcome.kind, "uncertain", JSON.stringify(outcome));
          assert.deepEqual(stored, r1);
        }
      },
    }),
  ),
  {
    id: "CLK-13",
    title: "the condition is inside the write: of two writers that read the same revision, the second to apply is refused and the first stands",
    needs: ["cas-in-write", "stall-write"],
    async run(subject, ctx) {
      const one = await subject.open(ctx);
      const two = await subject.open(ctx);
      const r1 = first(ctx);
      ok(await one.save(r1, null));
      const mine = next(r1, ctx);
      const theirs = { ...next(r1, ctx), updated_at: mine.updated_at + 7 };
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, G);
      const pending = one.save(mine, r1.revision);
      await stalledAt(stall, pending, "the first writer's save");
      ok(await two.save(theirs, r1.revision));
      stall.release();
      definite(await pending);
      assert.deepEqual(await (await subject.open(ctx)).load(G), theirs, "CAS-IN-WRITE: the stalled writer overwrote the clock that stood");
    },
  },
];
