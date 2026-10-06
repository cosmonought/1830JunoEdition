// server/src/aws/game/dynamoConductStore.ts
//
// ==================================================================
//  PHASE 3 (P3-N032): CONDUCT REVIEW CASES ON DYNAMODB -- CREATE-IF-ABSENT, CAS ON THE REVISION, POOL-FENCED
// ==================================================================
//
//   CONDUCT#<case>  CASE     `body` is the case's JSON text exactly as the file store writes it (one reader classifies
//                            both: `parseConductCaseDocument`); `revision` beside it; `att`/`atts` the attempt tokens.
//   LIST#conduct    <case>   the listing (`case_id`): written in the case's own creation, never removed.
//
// THE FENCE. A case is not a game's state -- it names a game, but no game write ever carries it and no game read ever
// reads it -- so its writes carry the POOL fence (`ConditionCheck POOL#<P>: writer_epoch = :E`, the fence of every write
// that names no game's HEAD): a stale task can create or change nothing. A report is received in the pool that serves
// its game; a review decision is taken by whichever task answers the reviewer; either way the CAS on the case's own
// revision decides a race, inside the write.
//
// CREATE: [POOL fence; Put CASE COND attribute_not_exists; Put LIST#conduct]. A case that already stands -- readable or
// not -- is kept and answered (a repeated report is one case).
// SAVE:   [POOL fence; Put CASE COND revision = expected AND att = the token of the item it read].
// Answers (the stores' usual three): committed (once -- a lost answer is settled by a strong read finding this write's
// token); definite (NOT written: the revision moved, this task was fenced, or DynamoDB refused it unapplied); uncertain
// (the answer was lost and could not be settled: it may still land; a reviewer reloads, a reporter's repeat is the same
// case). A stored case that cannot be read is never overwritten.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { COMMITTED, type StoreWriteOutcome } from "../../persistence/storeResult";
import { CASE_ID_PATTERN, ConductCaseUnreadableError, isConductCase, parseConductCaseDocument, serializeConductCase, type ConductCase } from "../../conduct/conductCase";
import type { ConductCaseStore, CreateCaseOutcome } from "../../conduct/conductStore";
import { carriesAttempt, CONDUCT_SK, conductPk, getItem, key, listKey, listPk, N, observedCondition, poolFence, queryAll, S, stampAttempt, type Item } from "./gameTable";
import { conditionFailed, describe, needsSettling, POOL_FENCED, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

const caseKey = (caseId: string): Item => key(conductPk(caseId), CONDUCT_SK);

export function createDynamoConductStore(options: GameTableStoreOptions): ConductCaseStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoConductStore");

  async function read(caseId: string): Promise<{ readonly item: Item | null; readonly value: ConductCase | null }> {
    const item = await getItem(client, table, caseKey(caseId));
    if (item === null) return { item, value: null };
    if (typeof item.body?.S !== "string") throw new ConductCaseUnreadableError(`the conduct case ${caseId} holds no document`, caseId);
    const value = parseConductCaseDocument(item.body.S, caseId);
    /* The revision every condition compares is the item's attribute: it must be the case's own, or the item is damage. */
    if (item.revision?.N !== String(value.revision)) throw new ConductCaseUnreadableError(`the conduct case ${caseId} disagrees with its item's revision attribute`, caseId);
    return { item, value };
  }

  /** What stands now under a case id: the case, an unreadable one (kept), or none. */
  async function standing(caseId: string): Promise<{ readonly item: Item | null; readonly value: ConductCase | null; readonly unreadable: boolean }> {
    try {
      const read_ = await read(caseId);
      return { ...read_, unreadable: false };
    } catch (error) {
      if (error instanceof ConductCaseUnreadableError) return { item: await getItem(client, table, caseKey(caseId)), value: null, unreadable: true };
      throw error;
    }
  }

  return {
    async list() {
      return (await queryAll(client, table, listPk("conduct"), { pageSize }))
        .map((item) => item.sk?.S ?? "")
        .filter((id) => CASE_ID_PATTERN.test(id))
        .sort();
    },

    async load(caseId) {
      if (!CASE_ID_PATTERN.test(caseId)) return null;
      return (await read(caseId)).value;
    },

    async create(value): Promise<CreateCaseOutcome> {
      const serialized = isConductCase(value) && value.revision === 1 ? serializeConductCase(value) : null;
      if (serialized === null) return { outcome: { kind: "definite", detail: "not a new conduct case" }, existing: null };
      const caseId = value.case_id;
      let before: Awaited<ReturnType<typeof standing>>;
      try {
        before = await standing(caseId);
      } catch (error) {
        return { outcome: { kind: "definite", detail: `could not read the conduct case ${caseId}: ${describe(error)}` }, existing: null };
      }
      if (before.value !== null) return { outcome: COMMITTED, existing: before.value };
      if (before.unreadable) return { outcome: COMMITTED, existing: null, existingUnreadable: true };
      const token = timing.token();
      const items: TransactWriteItem[] = [
        poolFence(table, fence),
        { Put: { TableName: table, Item: { ...caseKey(caseId), body: S(serialized), revision: N(value.revision), ...stampAttempt(token, null) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...listKey("conduct", caseId), case_id: S(caseId) } } },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return { outcome: answer.redone ? { kind: "committed", redone: true } : COMMITTED, existing: null };
      if (answer.kind === "not-applied") return { outcome: { kind: "definite", detail: `${answer.detail}; nothing was written` }, existing: null };
      if (!needsSettling(answer) && conditionFailed(answer, 0)) return { outcome: { kind: "definite", detail: POOL_FENCED }, existing: null };
      /* Another writer's case appeared meanwhile (the same report from another tab), or the answer was lost: what is
         stored decides. */
      let now: Awaited<ReturnType<typeof standing>>;
      try {
        now = await standing(caseId);
      } catch (error) {
        return { outcome: { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` }, existing: null };
      }
      if (carriesAttempt(now.item, token)) return { outcome: { kind: "committed", redone: true }, existing: null };
      if (now.value !== null) return { outcome: COMMITTED, existing: now.value };
      if (now.unreadable) return { outcome: COMMITTED, existing: null, existingUnreadable: true };
      if (answer.kind === "refused") return { outcome: { kind: "definite", detail: conditionFailed(answer, 0) ? POOL_FENCED : "the conduct case create was refused and nothing of it is stored" }, existing: null };
      return { outcome: { kind: "uncertain", detail: `${answer.detail}; the conduct case is not visible and an attempt may still be in flight` }, existing: null };
    },

    async save(value, expected): Promise<StoreWriteOutcome> {
      const serialized = isConductCase(value) ? serializeConductCase(value) : null;
      if (serialized === null) return { kind: "definite", detail: "not a conduct case" };
      const caseId = value.case_id;
      let current: Awaited<ReturnType<typeof read>>;
      try {
        current = await read(caseId); // an unreadable case throws: it is never overwritten
      } catch (error) {
        return { kind: "definite", detail: `the stored conduct case ${caseId} could not be read (${describe(error)}); nothing was written` };
      }
      if (current.value === null || current.item === null) return { kind: "definite", detail: `no conduct case ${caseId} is stored` };
      if (current.value.revision !== expected || value.revision !== expected + 1) return { kind: "definite", detail: `the conduct case moved (stored revision ${current.value.revision}, expected ${expected})` };
      const token = timing.token();
      const held = observedCondition(current.item);
      const items: TransactWriteItem[] = [
        poolFence(table, fence),
        {
          Put: {
            TableName: table,
            Item: { ...caseKey(caseId), body: S(serialized), revision: N(value.revision), ...stampAttempt(token, current.item) },
            ConditionExpression: `#rev = :expected AND ${held.expression}`,
            ExpressionAttributeNames: { "#rev": "revision", ...held.names },
            ExpressionAttributeValues: { ":expected": N(expected), ...held.values },
          },
        },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
      if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
      if (!needsSettling(answer)) {
        if (conditionFailed(answer, 0)) return { kind: "definite", detail: POOL_FENCED };
        return { kind: "definite", detail: `the conduct case ${caseId} changed while this write was prepared; nothing was written` };
      }
      let item: Item | null;
      try {
        item = await getItem(client, table, caseKey(caseId));
      } catch (error) {
        return { kind: "uncertain", detail: `the conduct case write's answer was lost and the read-back failed (${describe(error)})` };
      }
      if (carriesAttempt(item, token)) return { kind: "committed", redone: true };
      return answer.kind === "refused"
        ? { kind: "definite", detail: conditionFailed(answer, 0) ? POOL_FENCED : "the conduct case write was refused; nothing of it is stored" }
        : { kind: "uncertain", detail: "the conduct case write's answer was lost and it is not stored yet" };
    },
  };
}
