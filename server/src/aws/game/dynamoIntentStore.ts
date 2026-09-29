// server/src/aws/game/dynamoIntentStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: DURABLE CHAIN INTENTS ON DYNAMODB -- ONE PER SLOT, CREATED WITH THEIR RELAY-QUEUE ITEM
// ==================================================================
//
//   INTENT#<intent_id>                       the intent (`body`: its JSON text), `record_version`, `att`/`atts`.
//   RELAYQ#<queue>/<created_at>#<g>#<id>     what the relayer must still see (preflight §9.3). Made in the SAME transaction
//                                            as the intent (REQUIRED, §8.2: an intent without its queue item would never
//                                            be relayed); removed in the same write that makes the intent `confirmed` or
//                                            `superseded` -- and ONLY then: a HELD intent keeps it, because it may still
//                                            carry a live attempt the next relayer must observe (§4 row 17).
//   LIST#intent/<g>                          the port's listing (`games()`).
//
// CREATE: [FENCE(g); Put INTENT# attribute_not_exists; Put RELAYQ# attribute_not_exists; Put LIST#intent]. An existing
// intent at the slot answers `exists` (with `same` for the same subject and message); an unreadable one is never
// overwritten. PUT: [FENCE(g); Put INTENT# COND record_version = v AND att = the token it read; Delete RELAYQ# when
// terminal]. The relayer's own writes (L5-6) will carry the relayer-role fence instead of the game's.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { chainIntentFormat, ChainIntentUnreadableError, isChainIntentRecord, sameChainIntent, TERMINAL_INTENT_STATUSES, worstFormat, type ChainIntentRecord, type ChainIntentStore, type IntentCreateOutcome, type IntentPutOutcome } from "../../escrow/chainIntents";
import type { FormatFact } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import { COMMITTED } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { carriesAttempt, gameFence, gamePk, getItem, INTENT_PREFIX, intentSk, key, listKey, listPk, N, observedCondition, queryAll, relayQueueKey, S, stampAttempt, type Item } from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoIntentStoreOptions extends GameTableStoreOptions {
  /** The relay queue an intent is made in (the relayer's account address, preflight §3.2 `RELAYQ#<relayer-address>`). */
  readonly relayQueue: string;
}

export interface RelayQueueEntry {
  readonly game_id: string;
  readonly intent_id: string;
  readonly created_at: number;
}

export interface DynamoIntentStore extends ChainIntentStore {
  formatOf(gameId: string): Promise<FormatFact>;
  /** The relay queue, oldest first (L5-6's relayer reads it; strongly consistent). */
  relayQueue(): Promise<RelayQueueEntry[]>;
}

const INTENT_ID = /^[0-9a-f]{64}$/;
/** The relay-queue item's key, as the intent's creation stored it (carried on every rewrite of the intent). */
const queueOf = (item: Item): { relay_pk?: Item[string]; relay_sk?: Item[string] } =>
  item.relay_pk?.S !== undefined && item.relay_sk?.S !== undefined ? { relay_pk: item.relay_pk, relay_sk: item.relay_sk } : {};
const QUEUE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const TERMINAL = new Set<string>(TERMINAL_INTENT_STATUSES);

export function createDynamoIntentStore(options: DynamoIntentStoreOptions): DynamoIntentStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoIntentStore");
  if (typeof options.relayQueue !== "string" || !QUEUE.test(options.relayQueue)) throw new Error(`createDynamoIntentStore: ${JSON.stringify(options.relayQueue)} is not a relay queue name`);
  const queue = options.relayQueue;
  const intentKey = (gameId: string, intentId: string): Item => key(gamePk(gameId), intentSk(intentId));
  const validIds = (gameId: string, intentId: string) => GAME_ID_PATTERN.test(gameId) && INTENT_ID.test(intentId);

  function classify(gameId: string, intentId: string, item: Item | null): ChainIntentRecord | null {
    if (item === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.body?.S ?? "");
    } catch {
      throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is not JSON`, gameId, intentId);
    }
    const format = chainIntentFormat(parsed, gameId, intentId);
    if (format === "newer") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is in a NEWER format than this build reads; never parsed or overwritten here`, gameId, intentId, format);
    if (format === "older-unread") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is in an OLDER format this build no longer reads; never parsed or overwritten here`, gameId, intentId, format);
    if (format !== "current") throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} is not a valid intent`, gameId, intentId);
    /* The version every condition compares is the item's attribute: it must be the intent's own, or the item is damage. */
    if (item.record_version?.N !== String((parsed as ChainIntentRecord).record_version)) throw new ChainIntentUnreadableError(`chain intent ${intentId} of ${gameId} disagrees with its item's version attribute`, gameId, intentId);
    return parsed as ChainIntentRecord;
  }

  const factOf = (gameId: string, intentId: string, item: Item): FormatFact => {
    try {
      classify(gameId, intentId, item);
      return "current";
    } catch (error) {
      if (error instanceof ChainIntentUnreadableError) return error.format;
      throw error;
    }
  };

  async function gameItems(gameId: string): Promise<Item[]> {
    return queryAll(client, table, gamePk(gameId), { prefix: INTENT_PREFIX, pageSize });
  }

  return {
    async create(record): Promise<IntentCreateOutcome> {
      if (typeof record?.game_id !== "string" || typeof record.intent_id !== "string" || !validIds(record.game_id, record.intent_id) || !isChainIntentRecord(record) || record.record_version !== 1) {
        return { kind: "failed", detail: "not a new chain intent" };
      }
      const { game_id: gameId, intent_id: intentId } = record;
      const existing = async (): Promise<IntentCreateOutcome | null> => {
        const item = await getItem(client, table, intentKey(gameId, intentId));
        if (item === null) return null;
        try {
          const stored = classify(gameId, intentId, item) as ChainIntentRecord;
          return { kind: "exists", record: stored, same: sameChainIntent(stored, record) };
        } catch (error) {
          return { kind: "failed", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
        }
      };
      try {
        const before = await existing();
        if (before !== null) return before;
      } catch (error) {
        return { kind: "failed", detail: `the intent cannot be read: ${describe(error)}` };
      }
      const token = timing.token();
      const queued = relayQueueKey(queue, record.created_at, gameId, intentId);
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        { Put: { TableName: table, Item: { ...intentKey(gameId, intentId), body: S(JSON.stringify(record)), record_version: N(1), ...stampAttempt(token, null), relay_pk: queued.pk, relay_sk: queued.sk }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...queued, game_id: S(gameId), intent_id: S(intentId), created_at: N(record.created_at) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...listKey("intent", gameId), game_id: S(gameId) } } },
      ];
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return { kind: "created", record };
      if (answer.kind === "not-applied") return { kind: "failed", detail: `${answer.detail}; nothing was written` };
      if (!needsSettling(answer) && conditionFailed(answer, 0)) return { kind: "failed", detail: FENCED };
      let item: Item | null;
      try {
        item = await getItem(client, table, intentKey(gameId, intentId));
      } catch (error) {
        /* A create is create-if-absent: the caller's next attempt converges on whatever landed. */
        return { kind: "failed", detail: `the outcome is unknown and the settling read failed (${describe(error)}); a retry converges` };
      }
      if (carriesAttempt(item, token)) return { kind: "created", record };
      if (item !== null) {
        try {
          const stored = classify(gameId, intentId, item) as ChainIntentRecord;
          return { kind: "exists", record: stored, same: sameChainIntent(stored, record) };
        } catch (error) {
          return { kind: "failed", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
        }
      }
      if (answer.kind === "refused") return { kind: "failed", detail: conditionFailed(answer, 0) ? FENCED : "the intent create was refused and nothing of it is stored" };
      return { kind: "failed", detail: `${answer.detail}; the intent is not visible and an attempt may still be in flight (UNCERTAIN: a retry converges on it)` };
    },

    async put(next, expectedVersion): Promise<IntentPutOutcome> {
      if (typeof next?.game_id !== "string" || typeof next.intent_id !== "string" || !validIds(next.game_id, next.intent_id)) return { kind: "definite", detail: "not an intent of a game" };
      const { game_id: gameId, intent_id: intentId } = next;
      let observed: Item | null;
      let current: ChainIntentRecord | null;
      try {
        observed = await getItem(client, table, intentKey(gameId, intentId));
        current = classify(gameId, intentId, observed);
      } catch (error) {
        return { kind: "definite", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
      }
      if (current === null || current.record_version !== expectedVersion) return { kind: "conflict", current };
      if (!isChainIntentRecord(next) || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the intent" };
      const token = timing.token();
      const held = observedCondition(observed as Item);
      const items: TransactWriteItem[] = [
        gameFence(table, gameId, fence),
        {
          Put: {
            TableName: table,
            Item: { ...intentKey(gameId, intentId), body: S(JSON.stringify(next)), record_version: N(next.record_version), ...stampAttempt(token, observed), ...queueOf(observed as Item) },
            ConditionExpression: `#rv = :expected AND ${held.expression}`,
            ExpressionAttributeNames: { "#rv": "record_version", ...held.names },
            ExpressionAttributeValues: { ":expected": N(expectedVersion), ...held.values },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ];
      /* The queue item goes by the key the intent was CREATED with (stored on it), never by today's configuration. */
      if (TERMINAL.has(next.status) && !TERMINAL.has(current.status)) {
        const stored = queueOf(observed as Item);
        items.push({ Delete: { TableName: table, Key: stored.relay_pk !== undefined && stored.relay_sk !== undefined ? { pk: stored.relay_pk, sk: stored.relay_sk } : relayQueueKey(queue, current.created_at, gameId, intentId) } });
      }
      const answer = await transactWrite(client, items, { ...timing, token: () => token });
      if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
      if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
      const settled = needsSettling(answer);
      if (!settled && conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
      let item: Item | null = !settled && answer.kind === "refused" ? answer.reasons[1]?.item ?? null : null;
      try {
        if (item === null) item = await getItem(client, table, intentKey(gameId, intentId));
      } catch (error) {
        return { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` };
      }
      if (settled && carriesAttempt(item, token)) return { kind: "committed", redone: true };
      if (settled && answer.kind === "unknown") return { kind: "uncertain", detail: `${answer.detail}; the write is not visible and an attempt may still be in flight` };
      if (answer.kind === "refused" && conditionFailed(answer, 0)) return { kind: "definite", detail: FENCED };
      try {
        return { kind: "conflict", current: classify(gameId, intentId, item) };
      } catch (error) {
        return { kind: "definite", detail: `the intent cannot be read (${describe(error)}); it is never overwritten` };
      }
    },

    async load(gameId, intentId) {
      if (!validIds(gameId, intentId)) return null;
      return classify(gameId, intentId, await getItem(client, table, intentKey(gameId, intentId)));
    },

    async listGame(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return [];
      const out: ChainIntentRecord[] = [];
      for (const item of await gameItems(gameId)) {
        const record = classify(gameId, (item.sk?.S ?? "").slice(INTENT_PREFIX.length), item);
        if (record !== null) out.push(record);
      }
      return out.sort((a, b) => a.created_at - b.created_at || a.intent_id.localeCompare(b.intent_id));
    },

    async games() {
      return (await queryAll(client, table, listPk("intent"), { pageSize })).map((item) => item.sk?.S ?? "").filter((id) => GAME_ID_PATTERN.test(id)).sort();
    },

    async formatOf(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return "current";
      return worstFormat((await gameItems(gameId)).map((item) => factOf(gameId, (item.sk?.S ?? "").slice(INTENT_PREFIX.length), item)));
    },

    async relayQueue() {
      return (await queryAll(client, table, `RELAYQ#${queue}`, { pageSize })).map((item) => ({ game_id: item.game_id?.S ?? "", intent_id: item.intent_id?.S ?? "", created_at: Number(item.created_at?.N ?? "0") }));
    },
  };
}
