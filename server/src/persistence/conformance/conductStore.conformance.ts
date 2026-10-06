// server/src/persistence/conformance/conductStore.conformance.ts
//
// PHASE 3 (P3-N032): the conduct-case port (`ConductCaseStore`: CREATE-IF-ABSENT, then CONDITIONAL on the case's
// revision) as a behavioural suite every implementation runs -- memory and file here (`conductStore.conformance.test.ts`),
// DynamoDB in `dynamoGame.conformance.test.ts` against DynamoDB Local. A report must never be counted twice (the same
// case id is the same case, whoever raced), a case that cannot be read is never overwritten, a stale writer is never let
// through, and an unknown outcome is never called "nothing was written".

import assert from "node:assert/strict";

import { ConductCaseUnreadableError, decideCase, deriveEvidence, newConductCase, type ConductCase, type ConductParty } from "../../conduct/conductCase";
import type { ConductCaseStore } from "../../conduct/conductStore";
import { NO_FACTS } from "../../rooms/gameRecord";
import type { StoreWriteOutcome } from "../storeResult";
import type { Gate } from "./faults";
import { gameRecord, playerId, PRINCIPAL } from "./fixtures";
import { hook, rejection, sameTokenThenFresh, stalledAt, type CaseContext, type ConformanceCase, type SubjectBase } from "./harness";

export interface ConductSubject extends SubjectBase {
  open(ctx: CaseContext, options?: { readonly writerCheck?: () => Promise<boolean> }): Promise<ConductCaseStore>;
  /** The stored case, as bytes or item text (`null`: none) -- "nothing was written" is always checked. */
  stored(ctx: CaseContext, caseId: string): Promise<Buffer | string | null>;
  /** "corrupt": damage; "newer": a newer build's case format. */
  plant?(ctx: CaseContext, caseId: string, what: "corrupt" | "newer"): Promise<void>;
  stallNextWrite?(ctx: CaseContext, caseId: string): Gate;
  armLostAnswer?(ctx: CaseContext, caseId: string): void;
  armTransientFailure?(ctx: CaseContext, caseId: string): void;
  writeTokens?(ctx: CaseContext, caseId: string): string[];
  armUnknownThenStallResend?(ctx: CaseContext, caseId: string, landed: boolean): Gate;
  armUnevaluated?(ctx: CaseContext, caseId: string, landed: boolean): void;
}

const REPORTER: ConductParty = { player_id: playerId(1), principal_id: PRINCIPAL, nickname: "Reporter" };
const REPORTED: ConductParty = { player_id: playerId(2), principal_id: "pr_conformanceconformance02", nickname: "Reported" };
const REVIEWER = "pr_conformancereviewer000001";

/** A new case (revision 1) for the fixture game; `note` varies the content without varying the id. */
export function conductFixture(ctx: Pick<CaseContext, "now">, note: string | null = "first"): ConductCase {
  const record = gameRecord(1, ctx.now());
  const evidence = deriveEvidence({ record, facts: NO_FACTS, entries: [], reporter: REPORTER, reported: REPORTED, chat: [], money: null, clock: null, build: "conformance", now: ctx.now() });
  return newConductCase({ record, category: "stalling", reporter: REPORTER, reported: REPORTED, note, evidence, now: ctx.now() });
}

/** The case after one more review decision (revision + 1). */
export function decided(value: ConductCase, ctx: CaseContext, to: ConductCase["status"] = value.status === "under-review" ? "escalated" : "under-review"): ConductCase {
  const at = ctx.tick(1_000);
  const next = decideCase(value, { expectedRevision: value.revision, to, note: `decision at ${at}`, reviewerPrincipalId: REVIEWER, now: at });
  if (!("next" in next)) throw new Error(`the fixture decision was refused: ${next.reason}`);
  return next.next;
}

const ok = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "committed", `expected committed, got ${JSON.stringify(outcome)}`);
const definite = (outcome: StoreWriteOutcome) => assert.equal(outcome.kind, "definite", `expected definite, got ${JSON.stringify(outcome)}`);

async function unchanged(subject: ConductSubject, ctx: CaseContext, id: string, before: Buffer | string | null) {
  assert.deepEqual(await subject.stored(ctx, id), before, "a refused write leaves the stored case byte-identical");
}

export const CONDUCT_CASES: readonly ConformanceCase<ConductSubject>[] = [
  {
    id: "CND-01",
    title: "an empty store lists nothing, and a case id it does not hold loads null",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      assert.deepEqual(await store.list(), []);
      assert.equal(await store.load(conductFixture(ctx).case_id), null);
      assert.equal(await store.load("not-a-case-id"), null);
    },
  },
  {
    id: "CND-02",
    title: "a create commits, reads back exactly, and is listed",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const value = conductFixture(ctx);
      const created = await store.create(value);
      ok(created.outcome);
      assert.equal(created.existing, null);
      assert.deepEqual(await store.load(value.case_id), value);
      assert.deepEqual(await store.list(), [value.case_id]);
    },
  },
  {
    id: "CND-03",
    title: "create-if-absent: the same case id again keeps the case that stands, answers it, and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const first = conductFixture(ctx, "first");
      ok((await store.create(first)).outcome);
      const before = await subject.stored(ctx, first.case_id);
      const again = await store.create(conductFixture(ctx, "a different note, the same report"));
      ok(again.outcome);
      assert.deepEqual(again.existing, first, "the case that stood is answered");
      await unchanged(subject, ctx, first.case_id, before);
      assert.deepEqual(await store.list(), [first.case_id], "still one case");
    },
  },
  {
    id: "CND-04",
    title: "CAS on the revision: the current one commits; a stale or repeated expectation is DEFINITE and writes nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      ok((await store.create(r1)).outcome);
      const r2 = decided(r1, ctx);
      ok(await store.save(r2, 1));
      const before = await subject.stored(ctx, r1.case_id);
      definite(await store.save(decided(r2, ctx), 1));
      definite(await store.save(r2, 1));
      definite(await store.save(decided(decided(r2, ctx), ctx), 2));
      assert.deepEqual(await store.load(r1.case_id), r2);
      await unchanged(subject, ctx, r1.case_id, before);
    },
  },
  {
    id: "CND-05",
    title: "a save of a case that does not exist is DEFINITE and creates nothing",
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      definite(await store.save(decided(r1, ctx), 1));
      assert.equal(await subject.stored(ctx, r1.case_id), null);
      assert.deepEqual(await store.list(), []);
    },
  },
  {
    id: "CND-06",
    title: "restart: a reopened store reads the same case and continues it",
    needs: ["durable"],
    async run(subject, ctx) {
      const r1 = conductFixture(ctx);
      ok((await (await subject.open(ctx)).create(r1)).outcome);
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(r1.case_id), r1);
      assert.deepEqual(await reopened.list(), [r1.case_id]);
      ok(await reopened.save(decided(r1, ctx), 1));
    },
  },
  {
    id: "CND-07",
    title: "fence: after a takeover the stale writer's create and save are DEFINITE and write nothing; the newer writer continues",
    needs: ["fence"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const r1 = conductFixture(ctx);
      ok((await stale.create(r1)).outcome);
      const before = await subject.stored(ctx, r1.case_id);
      await ctx.fence.takeOver();
      definite(await stale.save(decided(r1, ctx), 1));
      await unchanged(subject, ctx, r1.case_id, before);
      const other = { ...conductFixture(ctx), category: "harassment" as const };
      const otherCase = { ...other, case_id: "cc_" + "f".repeat(32) };
      definite((await stale.create(otherCase)).outcome);
      assert.equal(await subject.stored(ctx, otherCase.case_id), null);
      const current = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      assert.deepEqual(await current.load(r1.case_id), r1);
      ok(await current.save(decided(r1, ctx), 1));
    },
  },
  {
    id: "CND-08",
    title: "a value that is not a conduct case (or a create that is not revision 1) is refused DEFINITE and writes nothing",
    needs: ["validates-shape"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      definite((await store.create({ ...r1, status: "escalated" } as ConductCase)).outcome);
      definite((await store.create({ ...r1, evidence: { ...r1.evidence, source: "client" } } as unknown as ConductCase)).outcome);
      definite((await store.create(decided(r1, ctx))).outcome);
      assert.equal(await subject.stored(ctx, r1.case_id), null);
      ok((await store.create(r1)).outcome);
      const before = await subject.stored(ctx, r1.case_id);
      definite(await store.save({ ...decided(r1, ctx), revision: 7 } as ConductCase, 1));
      await unchanged(subject, ctx, r1.case_id, before);
    },
  },
  ...(["corrupt", "newer"] as const).map(
    (what): ConformanceCase<ConductSubject> => ({
      id: `CND-09-${what}`,
      title: `an unreadable case (${what}) fails its read with ConductCaseUnreadableError, is listed, and is never overwritten`,
      needs: ["plant"],
      async run(subject, ctx) {
        const r1 = conductFixture(ctx);
        await hook(subject.plant, "plant")(ctx, r1.case_id, what);
        const before = await subject.stored(ctx, r1.case_id);
        assert.notEqual(before, null);
        const store = await subject.open(ctx);
        const error = await rejection(store.load(r1.case_id));
        assert.ok(error instanceof ConductCaseUnreadableError, String(error));
        assert.equal((error as ConductCaseUnreadableError).newer, what === "newer");
        assert.deepEqual(await store.list(), [r1.case_id], "an unreadable case is still listed (it is never hidden)");
        const created = await store.create(r1);
        assert.equal(created.outcome.kind, "committed", "a repeated report is answered as one that already stands");
        assert.equal(created.existing, null);
        assert.equal(created.existingUnreadable, true);
        definite(await store.save(decided(r1, ctx), 1));
        await unchanged(subject, ctx, r1.case_id, before);
      },
    }),
  ),
  {
    id: "CND-10",
    title: "idempotent retry: a create and a save whose answers were lost after they landed are each committed once",
    needs: ["inject-lost-answer", "durable"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, r1.case_id);
      ok((await store.create(r1)).outcome);
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, r1.case_id);
      const r2 = decided(r1, ctx);
      ok(await store.save(r2, 1));
      const reopened = await subject.open(ctx);
      assert.deepEqual(await reopened.load(r1.case_id), r2);
      assert.deepEqual(await reopened.list(), [r1.case_id]);
    },
  },
  {
    id: "CND-10-token",
    title: "the resend of a case write whose answer was lost carries the SAME client request token; the next write a fresh one",
    needs: ["inject-lost-answer", "idempotency-token"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      ok((await store.create(r1)).outcome);
      const tokens = hook(subject.writeTokens, "writeTokens");
      const before = tokens(ctx, r1.case_id).length;
      hook(subject.armLostAnswer, "armLostAnswer")(ctx, r1.case_id);
      const r2 = decided(r1, ctx);
      ok(await store.save(r2, 1));
      sameTokenThenFresh(tokens(ctx, r1.case_id).slice(before), 2);
      ok(await store.save(decided(r2, ctx), 2));
      sameTokenThenFresh(tokens(ctx, r1.case_id).slice(before), 3);
    },
  },
  {
    id: "CND-11",
    title: "transient failure before any effect: never committed, writes nothing; the retry commits",
    needs: ["inject-transient-failure"],
    async run(subject, ctx) {
      const store = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, r1.case_id);
      definite((await store.create(r1)).outcome);
      assert.equal(await subject.stored(ctx, r1.case_id), null);
      ok((await store.create(r1)).outcome);
      const before = await subject.stored(ctx, r1.case_id);
      hook(subject.armTransientFailure, "armTransientFailure")(ctx, r1.case_id);
      const r2 = decided(r1, ctx);
      definite(await store.save(r2, 1));
      await unchanged(subject, ctx, r1.case_id, before);
      ok(await store.save(r2, 1));
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<ConductSubject> => ({
      id: `CND-12-${landed ? "landed" : "unlanded"}-then-takeover`,
      title: landed
        ? "a resend never hides a stale writer: a decision that LANDED before a takeover is reported committed (it really is)"
        : "a resend never hides a stale writer: a decision that did NOT land before a takeover is refused on resend, never applied",
      needs: ["fence", "fence-in-write", "inject-lost-answer"],
      async run(subject, ctx) {
        const store = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
        const r1 = conductFixture(ctx);
        ok((await store.create(r1)).outcome);
        const resend = hook(subject.armUnknownThenStallResend, "armUnknownThenStallResend")(ctx, r1.case_id, landed);
        const r2 = decided(r1, ctx);
        const pending = store.save(r2, 1);
        await stalledAt(resend, pending, "the resend");
        await ctx.fence.takeOver();
        resend.release();
        const outcome = await pending;
        const stored = await (await subject.open(ctx, { writerCheck: ctx.fence.writer() })).load(r1.case_id);
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
    id: "CND-13",
    title: "fence inside the write: a takeover after the stale writer's own checks, before its write is applied, still refuses it",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const r1 = conductFixture(ctx);
      ok((await stale.create(r1)).outcome);
      const before = await subject.stored(ctx, r1.case_id);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, r1.case_id);
      const pending = stale.save(decided(r1, ctx), 1);
      await stalledAt(stall, pending, "the stale decision");
      await ctx.fence.takeOver();
      stall.release();
      const outcome = await pending;
      assert.equal(outcome.kind, "definite", `FENCE-IN-WRITE: the stale writer's in-flight decision was applied (${JSON.stringify(outcome)})`);
      await unchanged(subject, ctx, r1.case_id, before);
    },
  },
  {
    id: "CND-13-create",
    title: "fence inside the write: a stale task's case creation is refused even when the takeover lands after its own checks",
    needs: ["fence", "fence-in-write", "stall-write"],
    async run(subject, ctx) {
      const stale = await subject.open(ctx, { writerCheck: ctx.fence.writer() });
      const r1 = conductFixture(ctx);
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, r1.case_id);
      const pending = stale.create(r1);
      await stalledAt(stall, pending, "the stale create");
      await ctx.fence.takeOver();
      stall.release();
      const outcome = (await pending).outcome;
      assert.equal(outcome.kind, "definite", `FENCE-IN-WRITE: the stale writer's in-flight case creation was applied (${JSON.stringify(outcome)})`);
      assert.equal(await subject.stored(ctx, r1.case_id), null);
    },
  },
  ...([true, false] as const).map(
    (landed): ConformanceCase<ConductSubject> => ({
      id: `CND-14-${landed ? "landed" : "unlanded"}`,
      title: landed
        ? "a decision whose every resend went unevaluated, and which IS stored, is reported committed"
        : "a decision whose every resend went unevaluated, and which is NOT visible, is UNCERTAIN -- never 'nothing was written'",
      needs: ["inject-unevaluated", "durable"],
      async run(subject, ctx) {
        const store = await subject.open(ctx);
        const r1 = conductFixture(ctx);
        ok((await store.create(r1)).outcome);
        hook(subject.armUnevaluated, "armUnevaluated")(ctx, r1.case_id, landed);
        const r2 = decided(r1, ctx);
        const outcome = await store.save(r2, 1);
        const stored = await (await subject.open(ctx)).load(r1.case_id);
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
    id: "CND-15",
    title: "the condition is inside the write: of two reviewers that read the same revision, the second to apply is refused and the first stands",
    needs: ["cas-in-write", "stall-write"],
    async run(subject, ctx) {
      const one = await subject.open(ctx);
      const two = await subject.open(ctx);
      const r1 = conductFixture(ctx);
      ok((await one.create(r1)).outcome);
      const mine = decided(r1, ctx, "no-violation");
      const theirs = decided(r1, ctx, "conduct-confirmed");
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, r1.case_id);
      const pending = one.save(mine, 1);
      await stalledAt(stall, pending, "the first reviewer's decision");
      ok(await two.save(theirs, 1));
      stall.release();
      const outcome = await pending;
      assert.equal(outcome.kind, "definite", `CAS-IN-WRITE: the first reviewer's in-flight decision overwrote the one that stood (${JSON.stringify(outcome)})`);
      assert.deepEqual(await (await subject.open(ctx)).load(r1.case_id), theirs, "CAS-IN-WRITE: the stalled decision overwrote the one that stood");
    },
  },
  {
    id: "CND-16",
    title: "the condition is inside the write: of two tabs creating the same report at once, one case stands and the other is answered it",
    needs: ["cas-in-write", "stall-write"],
    async run(subject, ctx) {
      const one = await subject.open(ctx);
      const two = await subject.open(ctx);
      const first = conductFixture(ctx, "tab one");
      const second = conductFixture(ctx, "tab two");
      const stall = hook(subject.stallNextWrite, "stallNextWrite")(ctx, first.case_id);
      const pending = one.create(first);
      await stalledAt(stall, pending, "the first tab's create");
      ok((await two.create(second)).outcome);
      stall.release();
      const late = await pending;
      assert.equal(late.outcome.kind, "committed", JSON.stringify(late));
      assert.deepEqual(late.existing, second, "CAS-IN-WRITE: the first tab's in-flight create overwrote the case that stood");
      assert.deepEqual(await (await subject.open(ctx)).load(first.case_id), second);
      assert.deepEqual(await (await subject.open(ctx)).list(), [first.case_id]);
    },
  },
];
