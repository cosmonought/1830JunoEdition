// server/src/aws/game/dynamoFinancialStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE FINANCIAL RECORD ON DYNAMODB -- CREATE-IF-ABSENT, CAS, AND THE OPEN-MONEY-GAME INDEX
// ==================================================================
//
//   FIN                          the financial record (`body`: its JSON text), `record_version`, `att`/`atts`.
//   FINIDX#<identity-key>/GAME#g an OPEN money game, by the SHA-256 of its continuation identity (canonical JSON) --
//                                what L5-3's claim sweep and a pool's retirement check read. Removed in the SAME write
//                                that takes the record to `closed` or `cancelled`.
//   FINKEYS                      every identity key that ever had a money game (so the FINIDX# partitions can be
//                                enumerated without a scan).
//   LIST#fin/<g>                 the port's listing (every financial record, open or not).
//
// CREATE is a money game's birth (the financial record is written BEFORE the GameRecord, `moneyTables.ts`), so it
// may make the game's HEAD: [the POOL fence; the HEAD made, or already this writer's; Put FIN attribute_not_exists; Put
// LIST#fin; Put FINIDX#; ADD the key to FINKEYS]. A repeated creation converges on the first record.
// PUT: [FENCE(g); Put FIN COND record_version = v AND att = the token of the record it read; Delete FINIDX# when the
// record closes]. A stale record is a CONFLICT carrying the current one (from the refused condition's own old item).
//
// A stored record this build cannot read -- damage, a newer or an older format (`financialRecordFormat`) -- is refused
// with its class and never overwritten: every write reads it first, and every condition names the item it read.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { canonicalJson } from "../../../../frontend/src/gameEngine/stateDigest";
import { financialRecordFormat, FinancialRecordUnreadableError, type FinancialGameStore, type FinancialPutOutcome, type UnreadableFormat } from "../../escrow/financialGameStore";
import { isFinancialGameRecord, type FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { COMMITTED, type StoreWriteOutcome } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import {
  carriesAttempt,
  FIN_SK,
  finIndexKey,
  FINKEYS_KEY,
  gameFence,
  gamePk,
  getItem,
  headCreateOrMine,
  identityKeyOf,
  key,
  listKey,
  listPk,
  N,
  observedCondition,
  poolFence,
  queryAll,
  S,
  stampAttempt,
  type Item,
} from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, POOL_FENCED, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoFinancialStore extends FinancialGameStore {
  /** Every identity key that ever had a money game (L5-3's claim sweep). */
  identityKeys(): Promise<string[]>;
  /** The OPEN money games of one continuation identity (L5-3's claim sweep; a pool's retirement check). */
  openGames(identityKey: string): Promise<string[]>;
  /** LIVE-6 L6-7: EVERY open money game (FINKEYS, then each FINIDX# partition, every page, strongly consistent), for the
   *  escrow load and its chain sweep -- never the `LIST#fin` listing of every money game ever made. STRICT: a FINKEYS
   *  or FINIDX# item that is not exactly what the writes make refuses the whole answer (`OpenMoneyIndexDamageError`). */
  openMoneyGameIds(): Promise<string[]>;
}

/** LIVE-6 L6-7: the open-money-game index (FINKEYS / FINIDX#) holds an item this build cannot read: the discovery is
 *  refused whole (a skipped item could be the open game whose settlement must resume). */
export class OpenMoneyIndexDamageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMoneyIndexDamageError";
  }
}

const IDENTITY_KEY = /^[0-9a-f]{64}$/;
const sameNames = (item: Item, names: readonly string[]): boolean => {
  const have = Object.keys(item).sort();
  return have.length === names.length && have.every((name, at) => name === names[at]);
};

const finKey = (gameId: string): Item => key(gamePk(gameId), FIN_SK);
const CLOSED = new Set(["closed", "cancelled"]);

/** The FINIDX# partition of a record (null for a record with no identity: the held `financial-record-missing` placeholder). */
export const financialIdentityKey = (record: FinancialGameRecord): string | null => (record.continuation === null ? null : identityKeyOf(canonicalJson(record.continuation)));

export function createDynamoFinancialStore(options: GameTableStoreOptions): DynamoFinancialStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoFinancialStore");

  function classify(gameId: string, item: Item | null): FinancialGameRecord | null {
    if (item === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.body?.S ?? "");
    } catch {
      throw new FinancialRecordUnreadableError(`the financial record of ${gameId} is not JSON`, gameId);
    }
    const format = financialRecordFormat(parsed, gameId);
    if (format !== "current") throw new FinancialRecordUnreadableError(`the financial record of ${gameId} is ${format}; it is not continued here and never overwritten`, gameId, format as UnreadableFormat);
    /* The version every condition compares is the item's attribute: it must be the record's own, or the item is damage. */
    if (item.record_version?.N !== String((parsed as FinancialGameRecord).record_version)) throw new FinancialRecordUnreadableError(`the financial record of ${gameId} disagrees with its item's version attribute`, gameId);
    return parsed as FinancialGameRecord;
  }

  const refusal = (error: unknown): StoreWriteOutcome => ({ kind: "definite", detail: `${describe(error)}; it is never overwritten` });

  return {
    async list() {
      return (await queryAll(client, table, listPk("fin"), { pageSize })).map((item) => item.sk?.S ?? "").filter((id) => GAME_ID_PATTERN.test(id)).sort();
    },

    async load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return null;
      return classify(gameId, await getItem(client, table, finKey(gameId)));
    },

    async create(record) {
      if (typeof record?.game_id !== "string" || !GAME_ID_PATTERN.test(record.game_id) || !isFinancialGameRecord(record) || record.record_version !== 1) {
        return { outcome: { kind: "definite", detail: "not a new financial record" }, existing: null };
      }
      const gameId = record.game_id;
      const existingNow = async (): Promise<{ outcome: StoreWriteOutcome; existing: FinancialGameRecord | null } | "absent"> => {
        const item = await getItem(client, table, finKey(gameId));
        if (item === null) return "absent";
        try {
          return { outcome: COMMITTED, existing: classify(gameId, item) };
        } catch (error) {
          return { outcome: refusal(error), existing: null };
        }
      };
      let before: Awaited<ReturnType<typeof existingNow>>;
      try {
        before = await existingNow();
      } catch (error) {
        return { outcome: { kind: "definite", detail: `the financial record of ${gameId} cannot be read: ${describe(error)}` }, existing: null };
      }
      if (before !== "absent") return before;
      const token = timing.token();
      const identity = financialIdentityKey(record);
      const items: TransactWriteItem[] = [
        poolFence(table, fence),
        headCreateOrMine(table, gameId, fence),
        { Put: { TableName: table, Item: { ...finKey(gameId), body: S(JSON.stringify(record)), record_version: N(1), ...stampAttempt(token, null) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...listKey("fin", gameId), game_id: S(gameId) } } },
      ];
      if (identity !== null) {
        items.push({ Put: { TableName: table, Item: { ...finIndexKey(identity, gameId), game_id: S(gameId) } } });
        items.push({ Update: { TableName: table, Key: FINKEYS_KEY, UpdateExpression: "ADD #k :k", ExpressionAttributeNames: { "#k": "keys" }, ExpressionAttributeValues: { ":k": { SS: [identity] } } } });
      }
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return { outcome: answer.redone ? { kind: "committed", redone: true } : COMMITTED, existing: null };
      if (answer.kind === "not-applied") return { outcome: { kind: "definite", detail: `${answer.detail}; nothing was written` }, existing: null };
      if (!needsSettling(answer) && (conditionFailed(answer, 0) || conditionFailed(answer, 1))) return { outcome: { kind: "definite", detail: conditionFailed(answer, 0) ? POOL_FENCED : FENCED }, existing: null };
      /* Another creation landed first, or the answer was lost: what is stored decides. */
      let item: Item | null;
      try {
        item = await getItem(client, table, finKey(gameId));
      } catch (error) {
        return { outcome: { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` }, existing: null };
      }
      if (carriesAttempt(item, token)) return { outcome: { kind: "committed", redone: true }, existing: null };
      if (item !== null) {
        try {
          return { outcome: COMMITTED, existing: classify(gameId, item) };
        } catch (error) {
          return { outcome: refusal(error), existing: null };
        }
      }
      if (answer.kind === "refused") return { outcome: { kind: "definite", detail: conditionFailed(answer, 0) ? POOL_FENCED : conditionFailed(answer, 1) ? FENCED : "the creation was refused and nothing of it is stored" }, existing: null };
      return { outcome: { kind: "uncertain", detail: `${answer.detail}; the record is not visible and an attempt may still be in flight` }, existing: null };
    },

    async put(next, expectedVersion): Promise<FinancialPutOutcome> {
      if (typeof next?.game_id !== "string" || !GAME_ID_PATTERN.test(next.game_id)) return { kind: "definite", detail: "not a game id" };
      const gameId = next.game_id;
      let observed: Item | null;
      let current: FinancialGameRecord | null;
      try {
        observed = await getItem(client, table, finKey(gameId));
        current = classify(gameId, observed);
      } catch (error) {
        return refusal(error);
      }
      if (current === null || current.record_version !== expectedVersion) return { kind: "conflict", current };
      if (!isFinancialGameRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the record" };
      const token = timing.token();
      const held = observedCondition(observed as Item);
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        {
          Put: {
            TableName: table,
            Item: { ...finKey(gameId), body: S(JSON.stringify(next)), record_version: N(next.record_version), ...stampAttempt(token, observed) },
            ConditionExpression: `#rv = :expected AND ${held.expression}`,
            ExpressionAttributeNames: { "#rv": "record_version", ...held.names },
            ExpressionAttributeValues: { ":expected": N(expectedVersion), ...held.values },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ];
      const identity = financialIdentityKey(current);
      if (identity !== null && CLOSED.has(next.phase) && !CLOSED.has(current.phase)) items.push({ Delete: { TableName: table, Key: finIndexKey(identity, gameId) } });
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
      if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
      const settled = needsSettling(answer);
      if (!settled && conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
      /* The CAS term failed (or the answer was lost): the record as stored now decides. */
      let item: Item | null = !settled && answer.kind === "refused" ? answer.reasons[1]?.item ?? null : null;
      try {
        if (item === null) item = await getItem(client, table, finKey(gameId));
      } catch (error) {
        return { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` };
      }
      if (settled && carriesAttempt(item, token)) return { kind: "committed", redone: true };
      if (settled && answer.kind === "unknown") return { kind: "uncertain", detail: `${answer.detail}; the write is not visible and an attempt may still be in flight` };
      if (answer.kind === "refused" && conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
      try {
        return { kind: "conflict", current: classify(gameId, item) };
      } catch (error) {
        return refusal(error);
      }
    },

    async identityKeys() {
      return [...((await getItem(client, table, FINKEYS_KEY))?.keys?.SS ?? [])].sort();
    },

    async openMoneyGameIds() {
      const keysItem = await getItem(client, table, FINKEYS_KEY);
      const damaged = (why: string): never => {
        throw new OpenMoneyIndexDamageError(`the open-money-game index is damaged (${why}); the money games are not discovered rather than guessed at`);
      };
      let keys: string[] = [];
      if (keysItem !== null) {
        if (!sameNames(keysItem, ["keys", "pk", "sk"]) || !Array.isArray(keysItem.keys?.SS)) damaged("FINKEYS is not a set of identity keys");
        keys = [...(keysItem.keys.SS as string[])];
        if (keys.some((identity) => !IDENTITY_KEY.test(identity))) damaged("FINKEYS names something that is not an identity key");
      }
      const out = new Set<string>();
      for (const identity of keys.sort()) {
        for (const item of await queryAll(client, table, `FINIDX#${identity}`, { pageSize })) {
          const gameId = item.game_id?.S;
          if (!sameNames(item, ["game_id", "pk", "sk"]) || typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId) || item.sk?.S !== gamePk(gameId)) damaged(`FINIDX#${identity} / ${item.sk?.S ?? "?"}`);
          out.add(gameId as string);
        }
      }
      return [...out].sort();
    },

    async openGames(identityKey) {
      return (await queryAll(client, table, `FINIDX#${identityKey}`, { pageSize })).map((item) => item.game_id?.S ?? "").filter((id) => GAME_ID_PATTERN.test(id)).sort();
    },
  };
}
