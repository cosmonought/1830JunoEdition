// server/src/aws/game/gameTable.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE `game` TABLE -- KEYS, THE WRITER FENCE, SIZE LIMITS, AND THE OWNERSHIP PRIMITIVES L5-3 BUILDS ON
// ==================================================================
//
// One DynamoDB table (`gs-<env>-game-g<N>`, preflight §3) holds everything that must be restored together: every game's
// HEAD, record, log, chat, holds, financial record, chain intents and wallet-ticket ledger, plus the pools, the join-code
// index, the game directory and the listing indexes. Keys are `pk` (S, hash) and `sk` (S, range); every numeric sort
// component is zero-padded so the lexical order IS the numeric order. There are NO secondary indexes: every index the
// server relies on is a base-table item written in the SAME transaction that makes it true, and read strongly
// (`ConsistentRead`) -- a GSI can never be read strongly, so it can never serve an authority decision.
//
//   pk                         sk                               what
//   GAME#<g>                   HEAD                             owner_pool, pool_epoch, owner_task (diagnostic), log_next_index, log_bytes
//   GAME#<g>                   META                             the GameRecord (body = its JSON text), record_version
//   GAME#<g>                   LOG#%010d                        one log entry: `line` = the exact line the file store writes
//   GAME#<g>                   CHAT#<ms %013d>#<id>             one chat line (lossy)
//   GAME#<g>                   HOLD                             the live hold (body)
//   GAME#<g>                   HOLDREL#<held %013d>#<rel %013d> a released hold, kept as evidence (never deleted)
//   GAME#<g>                   FIN                              the financial record (body), record_version
//   GAME#<g>                   TICKETS                          the wallet-ticket ledger (body = the file store's envelope), version
//   GAME#<g>                   INTENT#<intent_id>               one chain intent (body), record_version
//   GAME#<g>                   CLOCK                            Phase 3 final clocks: the table clock (body), revision
//   POOL#<pool>                POOL                             writer_epoch, writer_task, taken_at (the pool's newest task)
//   JOIN#<code>                JOIN                             game_id (a hint: the record decides)
//   DIR#<yyyymm>               <created %013d>#<g>              game_id, pool, money (the game directory; written at record creation)
//   DIRKEYS                    DIRKEYS                          months (SS): every DIR# partition that exists
//   FINIDX#<identity-key>      GAME#<g>                         game_id: an OPEN money game, by continuation identity
//   FINKEYS                    FINKEYS                          keys (SS): every identity key that ever had a money game
//   RELAYQ#<queue>             <created %013d>#<g>#<intent_id>  game_id, intent_id: an intent the relayer must still see
//   LIST#<kind>                <g>                              game_id: the port listings (kind: log, hold, fin, intent, tickets)
//
// THE FENCE (preflight D-4, §4-§5). There is no lease and no clock. A pool's newest task takes the pool (`POOL#<P>`
// `writer_epoch` + 1) and CLAIMS each game it serves by stamping the game's HEAD with (pool, epoch). Every write to a game
// carries, INSIDE the same TransactWriteItems, the term
//
//     FENCE(g) = ConditionCheck GAME#<g>/HEAD: owner_pool = :P AND pool_epoch = :E
//
// (merged into the HEAD update's own condition when the write also updates HEAD -- DynamoDB allows one action per item),
// so a stale writer is refused BY DYNAMODB AT THE WRITE, however long it paused after its own checks. A write that makes a
// new game's HEAD (a record's creation, a money game's financial record), and a write that names no game (a join code),
// carries the POOL fence instead: `ConditionCheck POOL#<P>/POOL: writer_epoch = :E` -- a stale task can create nothing.
// `takeOverPool` / `claimGame` / `releaseGame` (`ownership.ts`) are the storage primitives L5-3's PoolWriter drives;
// nothing in L5-2 calls them on its own (tests use them to play a takeover).

import { createHash } from "crypto";
import {
  GetItemCommand,
  QueryCommand,
  TransactGetItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";

/* ------------------------------------------------------------------ */
/* Values and keys                                                      */
/* ------------------------------------------------------------------ */

export type Item = Record<string, AttributeValue>;

export const S = (value: string): AttributeValue => ({ S: value });
export const N = (value: number): AttributeValue => ({ N: String(value) });

const pad = (value: number, width: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`a key component must be a non-negative safe integer (${String(value)})`);
  const text = String(value);
  if (text.length > width) throw new Error(`a key component ${text} is wider than ${width} digits`);
  return text.padStart(width, "0");
};

export const gamePk = (gameId: string): string => `GAME#${gameId}`;
export const HEAD_SK = "HEAD";
export const META_SK = "META";
export const HOLD_SK = "HOLD";
export const FIN_SK = "FIN";
export const TICKETS_SK = "TICKETS";
/** Phase 3 final clocks: a table's clock record (`dynamoClockStore.ts`; control plane, decided inside gameplay's own
 *  serialization, fenced like every game write). */
export const CLOCK_SK = "CLOCK";
export const LOG_PREFIX = "LOG#";
export const CHAT_PREFIX = "CHAT#";
export const HOLDREL_PREFIX = "HOLDREL#";
export const INTENT_PREFIX = "INTENT#";

export const logSk = (index: number): string => `${LOG_PREFIX}${pad(index, 10)}`;
export const chatSk = (at: number, id: string): string => `${CHAT_PREFIX}${pad(at, 13)}#${id}`;
export const holdRelSk = (heldAt: number, releasedAt: number): string => `${HOLDREL_PREFIX}${pad(heldAt, 13)}#${pad(releasedAt, 13)}`;
export const intentSk = (intentId: string): string => `${INTENT_PREFIX}${intentId}`;

export const key = (pk: string, sk: string): Item => ({ pk: S(pk), sk: S(sk) });
export const headKey = (gameId: string): Item => key(gamePk(gameId), HEAD_SK);
export const poolKey = (pool: string): Item => key(`POOL#${pool}`, "POOL");
export const joinKey = (code: string): Item => key(`JOIN#${code}`, "JOIN");
export const DIRKEYS_KEY: Item = key("DIRKEYS", "DIRKEYS");
export const FINKEYS_KEY: Item = key("FINKEYS", "FINKEYS");
export const dirMonthOf = (createdAt: number): string => {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) throw new Error(`not a time: ${String(createdAt)}`);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};
export const dirKey = (gameId: string, createdAt: number): Item => key(`DIR#${dirMonthOf(createdAt)}`, `${pad(createdAt, 13)}#${gameId}`);
export const finIndexKey = (identityKey: string, gameId: string): Item => key(`FINIDX#${identityKey}`, gamePk(gameId));
/** The game is part of the sort key: an intent id is unique per game (`GAME#<g>/INTENT#<id>`), not across games. */
export const relayQueueKey = (queue: string, createdAt: number, gameId: string, intentId: string): Item => key(`RELAYQ#${queue}`, `${pad(createdAt, 13)}#${gameId}#${intentId}`);

export type ListKind = "log" | "hold" | "fin" | "intent" | "tickets";
export const listPk = (kind: ListKind): string => `LIST#${kind}`;
export const listKey = (kind: ListKind, gameId: string): Item => key(listPk(kind), gameId);

/** The SHA-256 (hex) of a money game's continuation identity in canonical JSON: its `FINIDX#` partition. */
export const identityKeyOf = (canonicalIdentityJson: string): string => createHash("sha256").update(canonicalIdentityJson, "utf8").digest("hex");

/** What the table is created with (tests, and L5-8's infrastructure): `pk`/`sk` strings, nothing else. */
export const GAME_TABLE_KEY_SCHEMA = Object.freeze({
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
  ],
});

/* ------------------------------------------------------------------ */
/* The writer fence                                                     */
/* ------------------------------------------------------------------ */

/** Who is writing: a pool and the epoch its newest task took (an operator run is a pool named `op:<run>`). */
export interface WriterFence {
  readonly pool: string;
  readonly epoch: number;
}

/** No owner: a game released by its pool (a value no pool id can take). */
export const NO_OWNER = "#none";
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;

export function fenceProblem(fence: WriterFence): string | null {
  if (typeof fence?.pool !== "string" || !POOL_ID.test(fence.pool)) return `the writer's pool ${JSON.stringify(fence?.pool)} is not a pool id`;
  if (!Number.isSafeInteger(fence.epoch) || fence.epoch < 1) return `the writer's epoch ${String(fence.epoch)} is not a positive integer`;
  return null;
}

/** FENCE(g): the game's HEAD names this writer. Checked by DynamoDB inside the transaction that carries it. */
export function gameFence(table: string, gameId: string, fence: WriterFence): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: headKey(gameId),
      ConditionExpression: "#op = :P AND #pe = :E",
      ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch" },
      ExpressionAttributeValues: { ":P": S(fence.pool), ":E": N(fence.epoch) },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  };
}

/** The pool fence: this writer's epoch is still its pool's newest. For writes that make a game or name none. */
export function poolFence(table: string, fence: WriterFence): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: poolKey(fence.pool),
      ConditionExpression: "#we = :E",
      ExpressionAttributeNames: { "#we": "writer_epoch" },
      ExpressionAttributeValues: { ":E": N(fence.epoch) },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  };
}

/** The HEAD term of a write that may BE a game's creation: the HEAD is made (owned by this writer) when absent, and
 *  otherwise must already be this writer's. Always paired with `poolFence` (a stale task may not make a game). */
export function headCreateOrMine(table: string, gameId: string, fence: WriterFence): TransactWriteItem {
  return {
    Update: {
      TableName: table,
      Key: headKey(gameId),
      UpdateExpression: "SET #op = if_not_exists(#op, :P), #pe = if_not_exists(#pe, :E), #ln = if_not_exists(#ln, :zero), #lb = if_not_exists(#lb, :zero)",
      ConditionExpression: "attribute_not_exists(pk) OR (#op = :P AND #pe = :E)",
      ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch", "#ln": "log_next_index", "#lb": "log_bytes" },
      ExpressionAttributeValues: { ":P": S(fence.pool), ":E": N(fence.epoch), ":zero": N(0) },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  };
}

/** Whether a HEAD (as a cancellation reason returned it, or a read) names this writer. */
export const headIsMine = (head: Item | null | undefined, fence: WriterFence): boolean =>
  head?.owner_pool?.S === fence.pool && head?.pool_epoch?.N === String(fence.epoch);

/* ------------------------------------------------------------------ */
/* Size limits: checked at the adapter boundary, BEFORE anything is sent                                 */
/* ------------------------------------------------------------------ */

/** DynamoDB refuses an item over 400 KB and a transaction over 100 actions or 4 MB. The adapters stay well inside them
 *  (preflight §3.2): a value that could not safely fit is refused DEFINITE before any request is issued -- never
 *  truncated, never split across items, never sent to be refused (or half-understood) by the service. */
export const SIZE_POLICY = Object.freeze({
  itemBytes: 350 * 1024,
  transactionBytes: 3.5 * 1024 * 1024,
  transactionActions: 80,
});

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

/** DynamoDB's size of one attribute value (its published rules, rounded up where they leave room). */
export function attributeValueSize(value: AttributeValue): number {
  if (value.S !== undefined) return utf8(value.S);
  if (value.N !== undefined) return 21; // at most 38 significant digits: 21 bytes, the upper bound
  if (value.B !== undefined) return value.B.byteLength;
  if (value.BOOL !== undefined || value.NULL !== undefined) return 1;
  if (value.SS !== undefined) return value.SS.reduce((sum, entry) => sum + utf8(entry), 0);
  if (value.NS !== undefined) return value.NS.length * 21;
  if (value.BS !== undefined) return value.BS.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (value.L !== undefined) return 3 + value.L.reduce((sum, entry) => sum + 1 + attributeValueSize(entry), 0);
  if (value.M !== undefined) return 3 + Object.entries(value.M).reduce((sum, [name, entry]) => sum + 1 + utf8(name) + attributeValueSize(entry), 0);
  return 1;
}

export const itemSize = (item: Item): number => Object.entries(item).reduce((sum, [name, value]) => sum + utf8(name) + attributeValueSize(value), 0);

/** The bytes one transaction action carries (its item or key, and its expression values). */
function actionSize(action: TransactWriteItem): number {
  const part = action.Put ?? action.Update ?? action.Delete ?? action.ConditionCheck;
  if (part === undefined) return 0;
  const body = "Item" in part && part.Item !== undefined ? part.Item : (part as { Key?: Item }).Key ?? {};
  const values = (part as { ExpressionAttributeValues?: Item }).ExpressionAttributeValues ?? {};
  const text = part as unknown as Record<string, unknown>;
  const expressions = ["UpdateExpression", "ConditionExpression"].reduce((sum, name) => sum + utf8(String(text[name] ?? "")), 0);
  return itemSize(body) + itemSize(values) + expressions;
}

/** Why this transaction cannot safely be sent (`null`: it fits). Every Put's item, and the whole request, are measured. */
export function transactionProblem(items: readonly TransactWriteItem[]): string | null {
  if (items.length === 0) return "an empty transaction";
  if (items.length > SIZE_POLICY.transactionActions) return `${items.length} actions in one transaction (the policy allows ${SIZE_POLICY.transactionActions})`;
  let total = 0;
  for (const action of items) {
    if (action.Put !== undefined) {
      const bytes = itemSize(action.Put.Item ?? {});
      if (bytes > SIZE_POLICY.itemBytes) return `an item of ${bytes} bytes (the policy allows ${SIZE_POLICY.itemBytes})`;
    }
    total += actionSize(action);
  }
  if (total > SIZE_POLICY.transactionBytes) return `a transaction of ${total} bytes (the policy allows ${SIZE_POLICY.transactionBytes})`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Attempt tokens                                                       */
/* ------------------------------------------------------------------ */

/** How many recent write tokens an item keeps (so a write whose answer was lost can be recognised later, even when the
 *  same owner wrote the item again since; the resend window bounds how far back that ever needs to look). */
export const RECENT_ATTEMPTS = 8;

/** The attempt attributes a whole-item Put stamps: `att` (this write's token) and `atts` (the recent tokens, newest
 *  last). `previous` is the item the write replaces (null for a create). */
export function stampAttempt(token: string, previous: Item | null): Item {
  const earlier = (previous?.atts?.L ?? []).map((entry) => entry.S ?? "").filter((entry) => entry !== "");
  return { att: S(token), atts: { L: [...earlier, token].slice(-RECENT_ATTEMPTS).map(S) } };
}

/** The condition that the item a write replaces is EXACTLY the item it read: its newest attempt token -- or, for an item
 *  no adapter stamped (planted, migrated), its whole body -- so a value this writer never saw (another build's, damage
 *  written at the same version) is never overwritten or deleted. */
export function observedCondition(item: Item): { readonly expression: string; readonly names: Record<string, string>; readonly values: Item } {
  const att = item.att?.S;
  if (att !== undefined) return { expression: "#att = :observed", names: { "#att": "att" }, values: { ":observed": S(att) } };
  const body = item.body?.S;
  if (body === undefined) return { expression: "attribute_not_exists(#att) AND attribute_not_exists(#body)", names: { "#att": "att", "#body": "body" }, values: {} };
  return { expression: "attribute_not_exists(#att) AND #body = :observedBody", names: { "#att": "att", "#body": "body" }, values: { ":observedBody": S(body) } };
}

/** Whether an item carries this write's token (as its newest write, or one of its recent ones). */
export const carriesAttempt = (item: Item | null | undefined, token: string): boolean =>
  item !== null && item !== undefined && (item.att?.S === token || (item.atts?.L ?? []).some((entry) => entry.S === token));

/* ------------------------------------------------------------------ */
/* Strong reads                                                         */
/* ------------------------------------------------------------------ */

export async function getItem(client: DynamoDBClient, table: string, itemKey: Item): Promise<Item | null> {
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: itemKey, ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item ?? null;
}

/** Several items read as ONE snapshot (TransactGetItems: never half of a transaction), in the order of `keys`. For a
 *  write's target set after a lost answer -- never with a shared fence item in it (that one is read on its own). */
export async function snapshot(client: DynamoDBClient, table: string, keys: readonly Item[]): Promise<Array<Item | null>> {
  if (keys.length === 0) return [];
  if (keys.length > 100) throw new Error(`a snapshot of ${keys.length} items is more than one TransactGetItems may read`);
  /* A snapshot read is cancelled while a transaction is writing one of its items -- our own resend, still in progress,
     included. A read is harmless to repeat: a few short retries before the caller answers uncertain. */
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await client.send(new TransactGetItemsCommand({ TransactItems: keys.map((itemKey) => ({ Get: { TableName: table, Key: itemKey } })) }), { abortSignal: deadline() });
      return (answer.Responses ?? []).map((response) => response.Item ?? null);
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? "";
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
      const conflict = name === "TransactionConflictException" || (name === "TransactionCanceledException" && reasons.some((reason) => reason.Code === "TransactionConflict"));
      if (!conflict || attempt >= 3) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** Every item of a partition (optionally under a sort-key prefix), in sort order, every page, strongly consistent. */
export async function queryAll(client: DynamoDBClient, table: string, pk: string, options: { readonly prefix?: string; readonly pageSize?: number } = {}): Promise<Item[]> {
  const out: Item[] = [];
  let start: Item | undefined;
  do {
    const answer = await client.send(
      new QueryCommand({
        TableName: table,
        ConsistentRead: true,
        KeyConditionExpression: options.prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: options.prefix === undefined ? { ":pk": S(pk) } : { ":pk": S(pk), ":prefix": S(options.prefix) },
        ExclusiveStartKey: start,
        ...(options.pageSize !== undefined ? { Limit: options.pageSize } : {}),
      }),
      { abortSignal: deadline() },
    );
    out.push(...(answer.Items ?? []));
    start = answer.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/* ------------------------------------------------------------------ */
/* HEAD reads                                                           */
/* ------------------------------------------------------------------ */

export interface HeadRead {
  readonly owner_pool: string | null;
  readonly pool_epoch: number | null;
  readonly owner_task: string | null;
  readonly log_next_index: number;
  readonly log_bytes: number;
}

export const numberOf = (value: AttributeValue | undefined): number | null => (value?.N === undefined ? null : Number(value.N));

export function headOf(item: Item | null): HeadRead | null {
  if (item === null) return null;
  return {
    owner_pool: item.owner_pool?.S ?? null,
    pool_epoch: numberOf(item.pool_epoch),
    owner_task: item.owner_task?.S ?? null,
    log_next_index: numberOf(item.log_next_index) ?? 0,
    log_bytes: numberOf(item.log_bytes) ?? 0,
  };
}

export const readHead = async (client: DynamoDBClient, table: string, gameId: string): Promise<HeadRead | null> => headOf(await getItem(client, table, headKey(gameId)));
