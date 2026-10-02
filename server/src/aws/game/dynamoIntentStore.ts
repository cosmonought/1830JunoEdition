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
// terminal].
//
// LIVE-5 L5-6: THE RELAYER'S VIEW (`relayerRole`). The relayer writes intents of games it may not own (preflight §4 rows
// 16-17, §9.4), so its writes carry the relayer role's mirror -- `ROLE_RL`, `aws/game/relayerRole.ts` -- INSIDE the
// same transaction, in the game fence's place: [ROLE_RL; Put INTENT# COND record_version = v AND att = the token it read;
// Delete RELAYQ# when terminal]. A refused ROLE_RL answers DEFINITE `RELAYER_ROLE_FENCED` (nothing written) and tells the
// role (`onFenced`: its self-check decides). The relayer never creates an intent: that view refuses `create`.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { chainIntentFormat, ChainIntentUnreadableError, isChainIntentRecord, RelayQueueDamageError, relayQueueOrder, sameChainIntent, TERMINAL_INTENT_STATUSES, worstFormat, type ChainIntentRecord, type ChainIntentStore, type IntentCreateOutcome, type IntentPutOutcome, type RelayQueueEntry } from "../../escrow/chainIntents";
import type { FormatFact } from "../../../../frontend/src/gameEngine/compat/continuationVerdict";
import { COMMITTED } from "../../persistence/storeResult";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { carriesAttempt, gameFence, gamePk, getItem, INTENT_PREFIX, intentSk, key, listKey, listPk, N, observedCondition, queryAll, relayQueueKey, S, stampAttempt, type Item } from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, resolveOptions, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoIntentStoreOptions extends GameTableStoreOptions {
  /** The relay queue an intent is made in (the relayer's account address, preflight §3.2 `RELAYQ#<relayer-address>`). */
  readonly relayQueue: string;
  /** LIVE-5 L5-6: the RELAYER's view (see the header): every `put` carries this role fence (ROLE_RL) instead of the
   *  game's HEAD fence; `create` is refused. `onFenced` is told when DynamoDB refused the role fence. */
  readonly relayerRole?: { readonly fence: () => TransactWriteItem; readonly onFenced?: (detail: string) => void };
}

/** LIVE-5 L5-6: a relayer intent write refused by ROLE_RL -- the mirror no longer names this relayer; nothing was written. */
export const RELAYER_ROLE_FENCED = "fenced: this task no longer holds the relayer role (the relayer role mirror moved); nothing was written";

export type { RelayQueueEntry };

export interface DynamoIntentStore extends ChainIntentStore {
  formatOf(gameId: string): Promise<FormatFact>;
  /** The relay queue, oldest first, strongly consistent, every page (LIVE-6 L6-7: the relayer's authoritative work
   *  discovery). STRICT: an entry whose key, attributes or attribute set disagree is refused with the whole answer
   *  (`RelayQueueDamageError`) -- never skipped, never read as a default. */
  relayQueue(): Promise<RelayQueueEntry[]>;
}

/** LIVE-6 L6-7: `<created_at %013d>#<game_id>#<intent_id>` -- the queue entry's sort key (`relayQueueKey`). */
const QUEUE_SK = /^([0-9]{13})#(g_[0-9a-z]{26})#([0-9a-f]{64})$/;
const QUEUE_ATTRIBUTES = ["created_at", "game_id", "intent_id", "pk", "sk"];

/** LIVE-6 L6-7: one stored queue item, read strictly (the exact attribute set the create writes, each equal to its key). */
export function parseRelayQueueItem(queue: string, item: Item): RelayQueueEntry {
  const where = `${item.pk?.S ?? "?"} / ${item.sk?.S ?? "?"}`;
  const damaged = (why: string): never => {
    throw new RelayQueueDamageError(`the relay-queue entry ${where} is damaged (${why}); the queue is not read rather than guessed at`);
  };
  if (item.pk?.S !== `RELAYQ#${queue}`) damaged("its partition is not this queue");
  const names = Object.keys(item).sort();
  if (names.length !== QUEUE_ATTRIBUTES.length || names.some((name, at) => name !== QUEUE_ATTRIBUTES[at])) damaged(`attributes ${names.join(",")}`);
  const match = QUEUE_SK.exec(item.sk?.S ?? "");
  if (match === null) damaged("its sort key");
  const [, created, gameId, intentId] = match as RegExpExecArray;
  if (!GAME_ID_PATTERN.test(gameId) || !INTENT_ID.test(intentId)) damaged("its sort key names no intent");
  const createdAt = Number(created);
  if (!Number.isSafeInteger(createdAt)) damaged("its creation time");
  if (item.game_id?.S !== gameId || item.intent_id?.S !== intentId || item.created_at?.N !== String(createdAt)) damaged("an attribute disagrees with its key");
  return { game_id: gameId, intent_id: intentId, created_at: createdAt };
}

const INTENT_ID = /^[0-9a-f]{64}$/;

/** JX-4B: one stored intent item, read strictly -- THE parser of an `INTENT#` item (the store's own reads call it; the
 *  operator's read-only evidence reader calls it too, so there is one parser): its body classified by the intent
 *  format, and its `record_version` attribute agreeing with the body (else the item is damage). Pure: reads nothing. */
export function parseChainIntentItem(gameId: string, intentId: string, item: Item): ChainIntentRecord {
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

/** JX-4B: the relay-queue key an intent item was CREATED with (`relay_pk` / `relay_sk`), or null when the item carries
 *  none. Pure. */
export function relayKeyOfIntentItem(item: Item): { readonly pk: string; readonly sk: string } | null {
  return item.relay_pk?.S !== undefined && item.relay_sk?.S !== undefined ? { pk: item.relay_pk.S, sk: item.relay_sk.S } : null;
}

/** The relay-queue item's key, as the intent's creation stored it (carried on every rewrite of the intent). */
const queueOf = (item: Item): { relay_pk?: Item[string]; relay_sk?: Item[string] } =>
  item.relay_pk?.S !== undefined && item.relay_sk?.S !== undefined ? { relay_pk: item.relay_pk, relay_sk: item.relay_sk } : {};
const QUEUE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const TERMINAL = new Set<string>(TERMINAL_INTENT_STATUSES);

export function createDynamoIntentStore(options: DynamoIntentStoreOptions): DynamoIntentStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoIntentStore");
  if (typeof options.relayQueue !== "string" || !QUEUE.test(options.relayQueue)) throw new Error(`createDynamoIntentStore: ${JSON.stringify(options.relayQueue)} is not a relay queue name`);
  const queue = options.relayQueue;
  const relayer = options.relayerRole;
  if (relayer !== undefined && typeof relayer.fence !== "function") throw new Error("createDynamoIntentStore: the relayer's view needs its role fence");
  /** The term at index 0 of every put: the game's HEAD fence, or (the relayer's view) the relayer role's ROLE_RL. */
  const putFence = (gameId: string): TransactWriteItem => (relayer !== undefined ? relayer.fence() : gameFence(table, gameId, fence));
  const putFenced = (): IntentPutOutcome => {
    if (relayer === undefined) return { kind: "definite", detail: FENCED };
    try {
      relayer.onFenced?.(RELAYER_ROLE_FENCED);
    } catch {
      /* the role's hook reports its own failures; the answer stands */
    }
    return { kind: "definite", detail: RELAYER_ROLE_FENCED };
  };
  const intentKey = (gameId: string, intentId: string): Item => key(gamePk(gameId), intentSk(intentId));
  const validIds = (gameId: string, intentId: string) => GAME_ID_PATTERN.test(gameId) && INTENT_ID.test(intentId);

  function classify(gameId: string, intentId: string, item: Item | null): ChainIntentRecord | null {
    if (item === null) return null;
    return parseChainIntentItem(gameId, intentId, item);
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
      if (relayer !== undefined) return { kind: "failed", detail: "the relayer's view of the intents creates none (an intent is made by its game's owner); nothing was written" };
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
        putFence(gameId),
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
      if (!settled && conditionFailed(answer, 0)) return putFenced();
      let item: Item | null = !settled && answer.kind === "refused" ? answer.reasons[1]?.item ?? null : null;
      try {
        if (item === null) item = await getItem(client, table, intentKey(gameId, intentId));
      } catch (error) {
        return { kind: "uncertain", detail: `the settling read failed: ${describe(error)}` };
      }
      if (settled && carriesAttempt(item, token)) return { kind: "committed", redone: true };
      if (settled && answer.kind === "unknown") return { kind: "uncertain", detail: `${answer.detail}; the write is not visible and an attempt may still be in flight` };
      if (answer.kind === "refused" && conditionFailed(answer, 0)) return putFenced();
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
      /* Every page (queryAll follows LastEvaluatedKey to the end), strongly consistent, oldest first by the key. */
      return (await queryAll(client, table, `RELAYQ#${queue}`, { pageSize })).map((item) => parseRelayQueueItem(queue, item)).sort(relayQueueOrder);
    },
  };
}
