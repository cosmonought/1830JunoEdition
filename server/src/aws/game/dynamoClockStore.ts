// server/src/aws/game/dynamoClockStore.ts
//
// ==================================================================
//  PHASE 3 LANE A (AUD-11.04): THE GAMEPLAY CLOCK ON DYNAMODB -- ONE ITEM PER TABLE, CAS ON ITS REVISION, FENCED
// ==================================================================
//
//   CLOCK   `body` is the clock record's JSON text exactly as the file store writes it (one reader classifies both:
//           `parseClockDocument`); `revision` beside it; `att`/`atts` the attempt tokens.
//
// PUT: [FENCE(g); Put CLOCK COND (expected null: attribute_not_exists; else revision = expected AND att = the token of the
// item it read)]. A stale writer is refused by the fence at the write (L5-3), like every other game write. The answers:
//   committed   written once (after a lost answer, settled by the strong read finding this write's token);
//   definite    NOT written: the revision moved, this writer was fenced, or DynamoDB refused it unapplied;
//   uncertain   the answer was lost and could not be settled -- the keeper rereads before its next decision.
// A stored clock that cannot be read is never overwritten (the table's clock is shown unavailable; the game is unaffected).
//
// No listing item: the clock is read per game, by the game's own load (an older build never reads it at all).

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { COMMITTED, type StoreWriteOutcome } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { isGameClockRecord, parseClockDocument, ClockUnreadableError, type ClockStore, type GameClockRecord } from "../../rooms/gameClock";
import { carriesAttempt, CLOCK_SK, gameFence, gamePk, getItem, key, N, observedCondition, S, stampAttempt, type Item } from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

const clockKey = (gameId: string): Item => key(gamePk(gameId), CLOCK_SK);

export function createDynamoClockStore(options: GameTableStoreOptions): ClockStore {
  const { client, table, fence, timing } = resolveOptions(options, "createDynamoClockStore");

  async function read(gameId: string): Promise<{ readonly item: Item | null; readonly record: GameClockRecord | null }> {
    const item = await getItem(client, table, clockKey(gameId));
    if (item === null) return { item, record: null };
    if (typeof item.body?.S !== "string") throw new ClockUnreadableError(`the clock of ${gameId} holds no document`, gameId);
    const record = parseClockDocument(item.body.S, gameId);
    /* The revision every condition compares is the item's attribute: it must be the record's own, or the item is damage. */
    if (item.revision?.N !== String(record.revision)) throw new ClockUnreadableError(`the clock of ${gameId} disagrees with its item's revision attribute`, gameId);
    return { item, record };
  }

  return {
    async load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return null;
      return (await read(gameId)).record;
    },

    async save(record, expected): Promise<StoreWriteOutcome> {
      if (!isGameClockRecord(record)) return { kind: "definite", detail: "not a clock record" };
      const gameId = record.game_id;
      let current: Awaited<ReturnType<typeof read>>;
      try {
        current = await read(gameId); // an unreadable clock throws: it is never overwritten
      } catch (error) {
        return { kind: "definite", detail: `the stored clock of ${gameId} could not be read (${describe(error)}); nothing was written` };
      }
      const stored = current.record === null ? null : current.record.revision;
      if (stored !== expected) return { kind: "definite", detail: `the clock moved (stored revision ${stored ?? "none"}, expected ${expected ?? "none"})` };
      const token = timing.token();
      const held = current.item === null ? null : observedCondition(current.item);
      const condition =
        held === null || expected === null
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: `#rev = :expected AND ${held.expression}`,
              ExpressionAttributeNames: { "#rev": "revision", ...held.names },
              ExpressionAttributeValues: { ":expected": N(expected), ...held.values },
            };
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        { Put: { TableName: table, Item: { ...clockKey(gameId), body: S(JSON.stringify(record)), revision: N(record.revision), ...stampAttempt(token, current.item) }, ...condition } },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
      if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
      if (!needsSettling(answer)) {
        if (answer.kind === "refused" && conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
        return { kind: "definite", detail: `the clock of ${gameId} changed while this write was prepared; nothing was written` };
      }
      let item: Item | null;
      try {
        item = await getItem(client, table, clockKey(gameId));
      } catch (error) {
        return { kind: "uncertain", detail: `the clock write's answer was lost and the read-back failed (${describe(error)})` };
      }
      if (carriesAttempt(item, token)) return COMMITTED;
      return answer.kind === "refused" ? { kind: "definite", detail: "the clock write was refused; nothing of it is stored" } : { kind: "uncertain", detail: "the clock write's answer was lost and it is not stored yet" };
    },
  };
}
