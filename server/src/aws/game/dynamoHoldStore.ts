// server/src/aws/game/dynamoHoldStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: DURABLE HOLDS ON DYNAMODB -- CREATE-IF-ABSENT, THE FIRST HOLD STANDS, RELEASE KEEPS THE EVIDENCE
// ==================================================================
//
//   HOLD                              the live hold (`body`: its JSON text), `att`/`atts`.
//   HOLDREL#<held_at>#<released_at>   a released hold with the operator's release, kept (never deleted).
//   LIST#hold/<g>                     the listing: present exactly while a live hold is.
//
// CREATE: [FENCE(g); Put HOLD COND attribute_not_exists; Put LIST#hold]. An existing hold -- readable or not -- is kept and
// answered (an unreadable hold already holds its game; it is left exactly as found).
// RELEASE (the operator, under its own claim of the game): [FENCE(g); Delete HOLD COND att = the token of the hold it
// read; Put HOLDREL# COND attribute_not_exists; Delete LIST#hold] -- ONE transaction, so a release is never half-applied
// (the file store's "evidence written, live hold not removed" window has no counterpart here).

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { COMMITTED, type StoreWriteOutcome } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { HoldUnreadableError, isGameHold, type CreateHoldOutcome, type GameHold, type HoldStore } from "../../rooms/holdStore";
import { carriesAttempt, gameFence, gamePk, getItem, HOLD_SK, HOLDREL_PREFIX, holdRelSk, key, listKey, listPk, observedCondition, queryAll, S, snapshot, stampAttempt, type Item } from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoHoldStore extends HoldStore {
  /** How many released holds of a game are kept (operators and tests). */
  releasedCopies(gameId: string): Promise<number>;
}

const holdKey = (gameId: string): Item => key(gamePk(gameId), HOLD_SK);

export function createDynamoHoldStore(options: GameTableStoreOptions): DynamoHoldStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoHoldStore");

  function classify(gameId: string, item: Item | null): GameHold | null {
    if (item === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.body?.S ?? "");
    } catch {
      throw new HoldUnreadableError(`the hold of ${gameId} is not JSON`, gameId);
    }
    if (!isGameHold(parsed) || parsed.game_id !== gameId) throw new HoldUnreadableError(`the hold of ${gameId} is not a hold of that game`, gameId);
    return parsed;
  }

  /** What stands now: the hold (kept), an unreadable one (kept, it holds), or none. */
  async function standing(gameId: string): Promise<{ readonly item: Item | null; readonly hold: GameHold | null; readonly unreadable: boolean }> {
    const item = await getItem(client, table, holdKey(gameId));
    try {
      return { item, hold: classify(gameId, item), unreadable: false };
    } catch (error) {
      if (error instanceof HoldUnreadableError) return { item, hold: null, unreadable: true };
      throw error;
    }
  }

  async function released(gameId: string): Promise<Item[]> {
    return queryAll(client, table, gamePk(gameId), { prefix: HOLDREL_PREFIX, pageSize });
  }

  return {
    async list() {
      return (await queryAll(client, table, listPk("hold"), { pageSize })).map((item) => item.sk?.S ?? "").filter((id) => GAME_ID_PATTERN.test(id)).sort();
    },

    async load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return null;
      return classify(gameId, await getItem(client, table, holdKey(gameId)));
    },

    async create(hold): Promise<CreateHoldOutcome> {
      if (!isGameHold(hold)) return { outcome: { kind: "definite", detail: "not a hold" }, existing: null };
      const gameId = hold.game_id;
      let before: Awaited<ReturnType<typeof standing>>;
      try {
        before = await standing(gameId);
      } catch (error) {
        return { outcome: { kind: "definite", detail: `could not read the hold of ${gameId}: ${describe(error)}` }, existing: null };
      }
      if (before.hold !== null) return { outcome: COMMITTED, existing: before.hold };
      if (before.unreadable) return { outcome: COMMITTED, existing: null };
      const token = timing.token();
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        { Put: { TableName: table, Item: { ...holdKey(gameId), body: S(JSON.stringify(hold)), ...stampAttempt(token, null) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...listKey("hold", gameId), game_id: S(gameId) } } },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return { outcome: answer.redone ? { kind: "committed", redone: true } : COMMITTED, existing: null };
      if (answer.kind === "not-applied") return { outcome: { kind: "definite", detail: `${answer.detail}; nothing was written` }, existing: null };
      if (!needsSettling(answer) && conditionFailed(answer, 0)) return { outcome: { kind: "definite", detail: FENCED }, existing: null };
      /* A hold appeared meanwhile, or the answer was lost: what is stored decides. */
      let now: Awaited<ReturnType<typeof standing>>;
      try {
        now = await standing(gameId);
      } catch (error) {
        return { outcome: { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` }, existing: null };
      }
      if (carriesAttempt(now.item, token)) return { outcome: { kind: "committed", redone: true }, existing: null };
      if (now.hold !== null) return { outcome: COMMITTED, existing: now.hold };
      if (now.unreadable) return { outcome: COMMITTED, existing: null };
      /* Absent: released since (by an operator) -- the released copy keeps the token -- or never written. */
      try {
        if ((await released(gameId)).some((item) => item.att_held?.S === token)) return { outcome: { kind: "committed", redone: true }, existing: null };
      } catch (error) {
        return { outcome: { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` }, existing: null };
      }
      if (answer.kind === "refused") return { outcome: { kind: "definite", detail: conditionFailed(answer, 0) ? FENCED : "the hold create was refused and nothing of it is stored" }, existing: null };
      return { outcome: { kind: "uncertain", detail: `${answer.detail}; the hold is not visible and an attempt may still be in flight` }, existing: null };
    },

    async release(gameId, release): Promise<StoreWriteOutcome> {
      let before: Awaited<ReturnType<typeof standing>>;
      try {
        before = await standing(gameId);
      } catch (error) {
        return { kind: "definite", detail: `could not read the hold of ${gameId}: ${describe(error)}` };
      }
      if (before.hold === null || before.item === null) return { kind: "definite", detail: `${gameId} holds no readable hold` };
      const token = timing.token();
      const releasedKey = key(gamePk(gameId), holdRelSk(before.hold.held_at, release.released_at));
      const observed = before.item.att?.S;
      const held = observedCondition(before.item);
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        {
          Delete: {
            TableName: table,
            Key: holdKey(gameId),
            /* Exactly the hold this release read and verified -- never a hold that replaced it meanwhile. */
            ConditionExpression: `attribute_exists(pk) AND ${held.expression}`,
            ExpressionAttributeNames: held.names,
            ...(Object.keys(held.values).length === 0 ? {} : { ExpressionAttributeValues: held.values }),
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              ...releasedKey,
              body: S(JSON.stringify({ ...before.hold, released: release })),
              att: S(token),
              ...(observed === undefined ? {} : { att_held: S(observed) }),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        { Delete: { TableName: table, Key: listKey("hold", gameId) } },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
      if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
      if (needsSettling(answer)) {
        /* The release's target set -- its released copy and the live hold -- as ONE snapshot. */
        let copy: Item | null;
        try {
          [copy] = await snapshot(client, table, [releasedKey, holdKey(gameId)]);
        } catch (error) {
          return { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` };
        }
        if (copy?.att?.S === token) return { kind: "committed", redone: true };
        if (answer.kind === "refused") return { kind: "definite", detail: conditionFailed(answer, 0) ? FENCED : "the release was refused on its resend; the hold stands" };
        return { kind: "uncertain", detail: `${answer.detail}; the release is not visible and an attempt may still be in flight` };
      }
      if (conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
      return { kind: "definite", detail: "the hold changed (or its released copy already exists) while the release was prepared; nothing was written" };
    },

    async releasedCopies(gameId) {
      return (await released(gameId)).length;
    },
  };
}
