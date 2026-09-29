// server/src/aws/game/dynamoRecordStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: GAME RECORDS, JOIN CODES AND THE GAME DIRECTORY ON DYNAMODB
// ==================================================================
//
//   META          the GameRecord: `body` is its JSON text; `record_version` beside it; `att`/`atts` the attempt tokens.
//   JOIN#<code>   the join-code index (a HINT: every lookup is checked against the record, as today).
//   DIR#<yyyymm>  the game directory: one item per record, written in the record's creation, never before or after.
//
// CREATE (put with expected null) is the game's birth, ONE transaction: [the POOL fence; the HEAD made (owned by this
// writer) or already this writer's; Put META attribute_not_exists; Put DIR#; ADD the month to DIRKEYS]. A stale task
// creates nothing.
// UPDATE (put with expected v): [FENCE(g); Put META COND record_version = v AND att = the token of the item it read] --
// the exact item this writer read, at the version it read, or nothing.
// CLAIM CODE: [the POOL fence; Put JOIN#c COND attribute_not_exists OR game_id = g] (idempotent for its own game).
// RELEASE CODE: [the POOL fence; Delete JOIN#c COND game_id = g] (only a code that still names the game).
//
// A stored record that is not exactly a record of its game is CORRUPT; a newer `record_schema` is INCOMPATIBLE (another
// build's); neither is ever overwritten (every write reads first, and its condition names the item it read).

import { ScanCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { COMMITTED, StoreCorruptError, StoreDefiniteError, StoreIncompatibleError, type StoreWriteOutcome } from "../../persistence/storeResult";
import { GAME_ID_PATTERN, isGameRecord, JOIN_CODE_PATTERN, type GameRecord } from "../../rooms/gameRecord";
import { recordSchemaNewer, type IndexReconciliation, type RecordStore } from "../../rooms/recordStore";
import {
  carriesAttempt,
  DIRKEYS_KEY,
  dirKey,
  dirMonthOf,
  gameFence,
  gamePk,
  getItem,
  headCreateOrMine,
  joinKey,
  key,
  META_SK,
  N,
  observedCondition,
  poolFence,
  queryAll,
  S,
  stampAttempt,
  type Item,
} from "./gameTable";
import { conditionFailed, describe, FENCED, needsSettling, POOL_FENCED, resolveOptions, type EvaluatedOrUnknown, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

export interface DynamoRecordStore extends RecordStore {
  reconcileIndex(live: ReadonlyMap<string, string>): Promise<IndexReconciliation>;
}

const metaKey = (gameId: string): Item => key(gamePk(gameId), META_SK);

export function createDynamoRecordStore(options: GameTableStoreOptions): DynamoRecordStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoRecordStore");

  /** The stored record, classified: `null` (none), the record, or a refusal. */
  function classify(gameId: string, item: Item | null): GameRecord | null {
    if (item === null) return null;
    const where = `the record of ${gameId}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.body?.S ?? "");
    } catch {
      throw new StoreCorruptError(`${where} is not JSON`, where, 0);
    }
    const newer = recordSchemaNewer(parsed);
    if (newer !== null) throw new StoreIncompatibleError(`${where} is record_schema ${newer}; this build reads record_schema 1 and 2`, where);
    if (!isGameRecord(parsed) || parsed.game_id !== gameId) throw new StoreCorruptError(`${where} is not a game record`, where, 0);
    /* The version every condition compares is the item's attribute: it must be the record's own, or the item is damage. */
    if (item.record_version?.N !== String(parsed.record_version)) throw new StoreCorruptError(`${where} disagrees with its item's version attribute`, where, 0);
    return parsed;
  }

  function versionProblem(record: GameRecord, expected: number | null, current: number | null): string | null {
    if (!isGameRecord(record)) return "not a game record";
    if (expected === null) {
      if (current !== null) return `game ${record.game_id} already exists`;
      if (record.record_version !== 1) return "a new record starts at version 1";
      return null;
    }
    if (current !== expected) return `version conflict on ${record.game_id}: expected ${expected}, the store holds ${current ?? "nothing"}`;
    if (record.record_version !== expected + 1) return "a record write must advance the version by exactly one";
    return null;
  }

  async function settleRecord(gameId: string, answer: EvaluatedOrUnknown, fenceAt: readonly number[]): Promise<StoreWriteOutcome> {
    let item: Item | null;
    try {
      item = await getItem(client, table, metaKey(gameId));
    } catch (error) {
      return { kind: "uncertain", detail: `${answer.detail}; the settling read failed: ${describe(error)}` };
    }
    if (carriesAttempt(item, answer.token)) return { kind: "committed", redone: true };
    if (answer.kind === "refused") return { kind: "definite", detail: fenceAt.some((at) => conditionFailed(answer, at)) ? FENCED : "the record moved; its resend was refused and nothing of it is stored" };
    return { kind: "uncertain", detail: `${answer.detail}; the record write is not visible and an attempt may still be in flight` };
  }

  async function put(record: GameRecord, expected: number | null): Promise<StoreWriteOutcome> {
    if (typeof record?.game_id !== "string" || !GAME_ID_PATTERN.test(record.game_id)) return { kind: "definite", detail: "not a game id" };
    const gameId = record.game_id;
    let observed: Item | null;
    let current: GameRecord | null;
    try {
      observed = await getItem(client, table, metaKey(gameId));
      current = classify(gameId, observed);
    } catch (error) {
      return { kind: "definite", detail: `the record of ${gameId} cannot be read (${describe(error)}); it is never overwritten` };
    }
    const problem = versionProblem(record, expected, current?.record_version ?? null);
    if (problem !== null) return { kind: "definite", detail: problem };
    const token = timing.token();
    const body = JSON.stringify(record);
    let items: TransactWriteItem[];
    let fenceAt: number[];
    if (expected === null) {
      const month = dirMonthOf(record.created_at);
      items = [
        poolFence(table, fence),
        headCreateOrMine(table, gameId, fence),
        { Put: { TableName: table, Item: { ...metaKey(gameId), body: S(body), record_version: N(1), ...stampAttempt(token, null) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: table, Item: { ...dirKey(gameId, record.created_at), game_id: S(gameId), pool: S(fence.pool), money: { BOOL: record.money !== null } } } },
        { Update: { TableName: table, Key: DIRKEYS_KEY, UpdateExpression: "ADD #m :m", ExpressionAttributeNames: { "#m": "months" }, ExpressionAttributeValues: { ":m": { SS: [month] } } } },
      ];
      fenceAt = [0, 1];
    } else {
      const held = observedCondition(observed as Item);
      items = [
        gameFence(table, gameId, fence),
        {
          Put: {
            TableName: table,
            Item: { ...metaKey(gameId), body: S(body), record_version: N(record.record_version), ...stampAttempt(token, observed) },
            ConditionExpression: `#rv = :expected AND ${held.expression}`,
            ExpressionAttributeNames: { "#rv": "record_version", ...held.names },
            ExpressionAttributeValues: { ":expected": N(expected), ...held.values },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
      ];
      fenceAt = [0];
    }
    const answer = await transactWrite(client, items, { ...timing, token: () => token });
    if (answer.kind === "applied") return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
    if (answer.kind === "not-applied") return { kind: "definite", detail: `${answer.detail}; nothing was written` };
    if (needsSettling(answer) || answer.kind !== "refused") return settleRecord(gameId, answer, fenceAt);
    if (fenceAt.some((at) => conditionFailed(answer, at))) return { kind: "definite", detail: expected === null && conditionFailed(answer, 0) ? POOL_FENCED : FENCED };
    return { kind: "definite", detail: `the record of ${gameId} changed while this write was prepared; nothing was written` };
  }

  async function listGames(): Promise<string[]> {
    const months = [...((await getItem(client, table, DIRKEYS_KEY))?.months?.SS ?? [])].sort();
    const out: string[] = [];
    for (const month of months) for (const item of await queryAll(client, table, `DIR#${month}`, { pageSize })) if (typeof item.game_id?.S === "string") out.push(item.game_id.S);
    return out;
  }

  /** The code's entry (`null` when unclaimed) and its holder. An entry that is not a code and a game id is damage. */
  async function entryOf(code: string): Promise<{ readonly item: Item; readonly holder: string } | null> {
    const item = await getItem(client, table, joinKey(code));
    if (item === null) return null;
    const gameId = item.game_id?.S;
    if (typeof gameId !== "string" || !GAME_ID_PATTERN.test(gameId)) throw new StoreCorruptError(`the join-code entry ${code} does not name a game`, `JOIN#${code}`, 0);
    return { item, holder: gameId };
  }
  const holderOf = async (code: string): Promise<string | null> => (await entryOf(code))?.holder ?? null;

  /** One pool-fenced write of the code index (`build` gets this write's token: a claim stamps it on the entry, so a
   *  release names the exact claim it removes); a thrown StoreDefiniteError means nothing was written. After a lost
   *  answer, `ours` judges the entry as it stands. */
  async function codeWrite(code: string, build: (token: string) => TransactWriteItem, ours: (entry: { readonly item: Item; readonly holder: string } | null) => boolean): Promise<"applied" | "refused"> {
    const token = timing.token();
    const answer = await transactWrite(client, [poolFence(table, fence), build(token)], { ...timing, token: () => token });
    if (answer.kind === "applied") return "applied";
    if (answer.kind === "not-applied") throw new StoreDefiniteError(`the join-code index was not written: ${answer.detail}`);
    if (needsSettling(answer)) {
      let entry: Awaited<ReturnType<typeof entryOf>>;
      try {
        entry = await entryOf(code);
      } catch (error) {
        throw new Error(`the join-code index write is unresolved: ${describe(error)}`);
      }
      if (ours(entry)) return "applied";
      if (answer.kind === "refused") {
        if (conditionFailed(answer, 0)) throw new StoreDefiniteError(POOL_FENCED);
        return "refused";
      }
      throw new Error(`the join-code index write is unresolved: ${answer.detail}`);
    }
    if (conditionFailed(answer, 0)) throw new StoreDefiniteError(POOL_FENCED);
    return "refused";
  }

  return {
    async list() {
      return listGames();
    },

    async load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return null;
      return classify(gameId, await getItem(client, table, metaKey(gameId)));
    },

    put,

    async lookupCode(code) {
      return holderOf(code);
    },

    async claimCode(code, gameId) {
      if (!JOIN_CODE_PATTERN.test(code) || !GAME_ID_PATTERN.test(gameId)) throw new StoreDefiniteError("not a join code and a game id");
      const holder = await holderOf(code);
      if (holder !== null && holder !== gameId) return "taken";
      const written = await codeWrite(
        code,
        (token) => ({
          Put: {
            TableName: table,
            Item: { ...joinKey(code), game_id: S(gameId), claim: S(token) },
            ConditionExpression: "attribute_not_exists(pk) OR #g = :g",
            ExpressionAttributeNames: { "#g": "game_id" },
            ExpressionAttributeValues: { ":g": S(gameId) },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        }),
        (entry) => entry?.holder === gameId,
      );
      return written === "applied" ? "claimed" : "taken";
    },

    /* The Delete names the exact CLAIM it read (review round 3): a release whose answer was lost and which lands late can
       never remove a later claim of the same code, even by the same game. */
    async releaseCode(code, gameId) {
      const entry = await entryOf(code);
      if (entry === null || entry.holder !== gameId) return;
      const claim = entry.item.claim?.S;
      await codeWrite(
        code,
        () => ({
          Delete: {
            TableName: table,
            Key: joinKey(code),
            ConditionExpression: claim === undefined ? "#g = :g AND attribute_not_exists(#c)" : "#g = :g AND #c = :c",
            ExpressionAttributeNames: { "#g": "game_id", "#c": "claim" },
            ExpressionAttributeValues: { ":g": S(gameId), ...(claim === undefined ? {} : { ":c": S(claim) }) },
          },
        }),
        (now) => now === null || now.item.claim?.S !== claim,
      );
    },

    /* LIVE-3C's reconciliation, as an operator command in AWS (preflight §13 step 3), meant for maintenance mode: the
       records are the authority. The code entries are found with one strongly consistent scan (the whole table: an
       operator's job, never a request's). Every change is pool-fenced AND conditioned on the entry as the scan saw it, so
       a claim made meanwhile is never overwritten; an entry that does not name a game is DAMAGE and is left exactly as
       found (counted with the orphans; the operator repairs it). Nothing is removed. */
    async reconcileIndex(live) {
      const current = new Map<string, string | null>();
      let start: Item | undefined;
      do {
        const page = await client.send(
          new ScanCommand({ TableName: table, ConsistentRead: true, FilterExpression: "begins_with(pk, :join)", ExpressionAttributeValues: { ":join": S("JOIN#") }, ExclusiveStartKey: start }),
          { abortSignal: deadline() },
        );
        for (const item of page.Items ?? []) {
          const gameId = item.game_id?.S;
          current.set((item.pk?.S ?? "").slice("JOIN#".length), typeof gameId === "string" && GAME_ID_PATTERN.test(gameId) ? gameId : null);
        }
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
      let added = 0;
      let repointed = 0;
      let outcome: StoreWriteOutcome = COMMITTED;
      const damaged: string[] = [];
      for (const [code, gameId] of live) {
        const holder = current.get(code);
        if (holder === gameId) continue;
        if (holder === null) {
          damaged.push(code);
          continue;
        }
        const seen =
          holder === undefined
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : { ConditionExpression: "#g = :seen", ExpressionAttributeNames: { "#g": "game_id" }, ExpressionAttributeValues: { ":seen": S(holder) } };
        try {
          const written = await codeWrite(code, (token) => ({ Put: { TableName: table, Item: { ...joinKey(code), game_id: S(gameId), claim: S(token) }, ...seen } }), (now) => now?.holder === gameId);
          if (written !== "applied") {
            outcome = { kind: "definite", detail: `the entry of ${code} changed while the index was reconciled; nothing was written for it` };
            break;
          }
        } catch (error) {
          outcome = error instanceof StoreDefiniteError ? { kind: "definite", detail: error.message } : { kind: "uncertain", detail: describe(error) };
          break;
        }
        if (holder === undefined) added += 1;
        else repointed += 1;
        current.set(code, gameId);
      }
      if (outcome.kind === "committed" && damaged.length > 0) outcome = { kind: "definite", detail: `${damaged.length} join-code entr${damaged.length === 1 ? "y does" : "ies do"} not name a game (${damaged.slice(0, 5).join(", ")}); left exactly as found for the operator` };
      const orphans = [...current.entries()].filter(([code, gameId]) => live.get(code) !== gameId).length;
      return { rebuilt: false, added, repointed, orphans, outcome };
    },
  };
}
