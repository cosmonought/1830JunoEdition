// server/src/aws/game/dynamoLogStore.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE GAMEPLAY LOG ON DYNAMODB -- ONE ITEM PER ENTRY, THE FILE STORE'S LINE VERBATIM, A BATCH WITH ITS HEAD
// ==================================================================
//
// The log is the gameplay authority. Its DynamoDB shape (preflight D-6, §6):
//
//   LOG#%010d     one item per entry. `line` is EXACTLY the line the file store writes for that entry -- the entry's own
//                 JSON text with the batch stamp `"batch":[first,last]` last (`logFormat.ts` serializeBatch) -- so every
//                 byte of every payload round-trips, `logHash` and every digest are unchanged, and an export
//                 (`line` + "\n", in index order) is byte-identical to a file log. Entry fields are NEVER mapped to
//                 DynamoDB types. `att` is the attempt token of the write that made it.
//   HEAD          `log_next_index` (and `log_bytes`, a diagnostic) move in the SAME transaction as the batch's items.
//
// APPEND = ONE TransactWriteItems: [Update HEAD SET log_next_index = n+k  COND owner_pool = :P AND pool_epoch = :E AND
// log_next_index = n (the fence and the index, one condition: one action per item); Put LOG#n ... LOG#n+k-1 COND
// attribute_not_exists; the first batch also puts its `LIST#log` entry]. All of it, or none: a transaction cannot tear.
//
// LOAD = the HEAD and every LOG# item, strongly, and the SAME reader the file store uses (`scanLog`) over the lines:
//   clean         served -- and only if every item sits at its own index and HEAD counts exactly those entries;
//   newer-format  a complete record this build cannot read: StoreIncompatibleError, touching nothing (LIVE-4 N-3);
//   anything else damage: StoreCorruptError, touching nothing. A "torn tail" is damage HERE: a transaction cannot
//                 tear, so items that do not complete a batch were never written by this protocol. Nothing is ever
//                 truncated, repaired, overwritten or deleted.
// A store instance appends to a room only after it has loaded (validated) it, so no batch is ever written behind
// damage or behind another build's records.
//
// THE BATCH BOUND. DynamoDB allows 100 actions per transaction; the policy keeps 80 (preflight §3.2). A batch is at most
// `DYNAMO_LOG_MAX_BATCH` entries (the HEAD update and the first batch's listing take the rest) -- more than the 65 the
// actor builds by construction (LIVE-3 §6.2), fewer than the file store's 100. A larger batch, an entry item over the item
// bound, or a transaction over the byte bound is refused DEFINITE before anything is sent.
//
// CHAT is lossy and separate: one fenced single-attempt write per line (`CHAT#<ms>#<id>`), never retried; a failure is
// thrown to the caller, which counts it.

import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";

import type { ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { RoomChatEntry } from "../../../../frontend/src/utils/roomProtocol";
import type { LogHeadRead, LogStore } from "../../fileLogStore";
import { parseEntryLine, scanLog, serializeBatch } from "../../persistence/logFormat";
import { COMMITTED, StoreCorruptError, StoreIncompatibleError, throwUnlessCommitted, type StoreWriteOutcome } from "../../persistence/storeResult";
import {
  chatSk,
  gameFence,
  gamePk,
  getItem,
  headIsMine,
  headKey,
  headOf,
  key,
  listKey,
  listPk,
  LOG_PREFIX,
  logSk,
  N,
  queryAll,
  S,
  SIZE_POLICY,
  snapshot,
  CHAT_PREFIX,
  type Item,
} from "./gameTable";
import { describe, FENCED, needsSettling, resolveOptions, type EvaluatedOrUnknown, type GameTableStoreOptions } from "./storeSupport";
import { transactWrite } from "./transact";

/** The most entries one batch may carry here: the policy's actions, less the HEAD update and the first batch's listing. */
export const DYNAMO_LOG_MAX_BATCH = SIZE_POLICY.transactionActions - 2;

const GAME_LOG = /^g_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]$/;
/** A room id becomes a key component as it is (no path to escape here), bounded and printable. */
const ROOM = /^[\x21-\x7e]{1,128}$/;
const CHAT_ID = /^[\x21-\x7e]{1,128}$/;

export interface DynamoLogStore extends LogStore {
  appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome>;
  loadChat(room: string): Promise<readonly RoomChatEntry[]>;
  appendChat(room: string, entry: RoomChatEntry): Promise<void>;
  listGameLogs(): Promise<string[]>;
  readHead(room: string): Promise<LogHeadRead>;
  /** The room's committed log exactly as a file log would hold it (`line` + "\n" per entry), validated first. */
  exportLog(room: string): Promise<Buffer>;
}

export function createDynamoLogStore(options: GameTableStoreOptions): DynamoLogStore {
  const { client, table, fence, timing, pageSize } = resolveOptions(options, "createDynamoLogStore");
  /** Rooms this instance has validated, and where each continues. Dropped on any outcome that is not definite. */
  const validated = new Map<string, number>();

  async function validatedLoad(room: string, onProgress?: () => void): Promise<ServerLogEntry[]> {
    return (await validatedRead(room, onProgress)).entries;
  }

  /** The room's committed log, VALIDATED (see the header): its entries and its exact stored lines. */
  async function validatedRead(room: string, onProgress?: () => void): Promise<{ readonly entries: ServerLogEntry[]; readonly lines: readonly string[] }> {
    const head = headOf(await getItem(client, table, headKey(room)));
    /* One item per entry, read a page at a time: each page is reported, so a long history is bounded per page, never
       as a whole (no length limit -- owner ruling, 2026-10-07). */
    const items = await queryAll(client, table, gamePk(room), { prefix: LOG_PREFIX, pageSize, ...(onProgress !== undefined ? { onPage: onProgress } : {}) });
    const where = `the log of ${room}`;
    if (items.length === 0) {
      if (head !== null && head.log_next_index !== 0) throw new StoreCorruptError(`${where}: its HEAD counts ${head.log_next_index} entries and none is stored`, where, 0);
      validated.set(room, 0);
      return { entries: [], lines: [] };
    }
    const lines: string[] = [];
    for (const item of items) {
      const line = item.line?.S;
      if (line === undefined || line.includes("\n")) throw new StoreCorruptError(`${where}: the item ${item.sk?.S ?? "?"} holds no entry line`, where, lines.length);
      lines.push(line);
    }
    const scan = scanLog(Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8"));
    if (scan.classification === "newer-format") {
      validated.delete(room);
      throw new StoreIncompatibleError(`${where}: ${scan.detail}`, where);
    }
    if (scan.classification !== "clean") {
      validated.delete(room);
      throw new StoreCorruptError(`${where}: ${scan.detail}${scan.classification === "torn-tail" ? " (a transaction cannot tear: this is damage, left exactly as found)" : ""}`, where, scan.damageAt ?? 0);
    }
    for (const [at, item] of items.entries()) {
      if (item.sk?.S !== logSk(at)) throw new StoreCorruptError(`${where}: entry ${at} is stored at ${item.sk?.S ?? "?"}`, where, at);
    }
    if (head === null) throw new StoreCorruptError(`${where}: ${items.length} entries are stored with no HEAD`, where, 0);
    if (head.log_next_index !== scan.entries.length) throw new StoreCorruptError(`${where}: its HEAD counts ${head.log_next_index} entries, ${scan.entries.length} are stored`, where, 0);
    validated.set(room, scan.entries.length);
    return { entries: scan.entries, lines };
  }

  const definite = (detail: string): StoreWriteOutcome => ({ kind: "definite", detail });

  /** The strong read after an unknown outcome: are THIS write's items there? */
  async function settle(room: string, first: number, count: number, answer: EvaluatedOrUnknown): Promise<StoreWriteOutcome> {
    let items: Item[];
    let head: Item | null;
    try {
      /* The fence on its own, then the batch's items as ONE snapshot (storeSupport.ts, the read pattern). */
      head = await getItem(client, table, headKey(room));
      items = (await snapshot(client, table, Array.from({ length: count }, (_, at) => key(gamePk(room), logSk(first + at))))).filter((item): item is Item => item !== null);
    } catch (error) {
      validated.delete(room);
      return { kind: "uncertain", detail: `${answer.kind === "unknown" ? answer.detail : "a resend was refused"}; the settling read failed: ${describe(error)}` };
    }
    const ours = items.filter((item) => item.att?.S === answer.token).length;
    if (ours === count) {
      validated.set(room, first + count);
      return { kind: "committed", redone: true };
    }
    validated.delete(room);
    if (ours > 0) return { kind: "uncertain", detail: `only ${ours} of the batch's ${count} entries carry its token (a transaction cannot tear: the table was touched outside the protocol)` };
    if (answer.kind === "refused") return definite(!headIsMine(head, fence) ? FENCED : `the batch at index ${first} was refused on its resend and is not stored; nothing was written`);
    return { kind: "uncertain", detail: `${answer.detail}; the batch is not visible and an attempt may still be in flight` };
  }

  async function appendBatch(room: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome> {
    if (entries.length === 0) return COMMITTED;
    if (!ROOM.test(room)) return definite(`${JSON.stringify(room)} is not a room id`);
    if (entries.length > DYNAMO_LOG_MAX_BATCH) return definite(`a batch of ${entries.length} entries is larger than one DynamoDB transaction may carry here (${DYNAMO_LOG_MAX_BATCH})`);
    /* WHAT IS COMMITTED MUST LOAD BACK (conformance LOG-07): every line is read back by the loader's own parser first. */
    let lines: string[];
    try {
      lines = serializeBatch(entries).split("\n").slice(0, -1);
      lines.forEach((line, at) => {
        const parsed = parseEntryLine(line);
        if (parsed === null || parsed.entry.index !== entries[at].index) throw new Error(`entry ${at} of the batch would not load back as an entry`);
      });
    } catch (error) {
      return definite(`the batch could not be serialized: ${describe(error)}`);
    }
    if (!validated.has(room)) {
      try {
        await validatedLoad(room);
      } catch (error) {
        return definite(`could not open the log for ${room}: ${describe(error)}`);
      }
    }
    const next = validated.get(room) as number;
    const first = entries[0].index;
    if (first !== next) return definite(`the batch begins at index ${first} but ${room}'s log continues at ${next}; nothing was written`);
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    const items: TransactWriteItem[] = [
      {
        Update: {
          TableName: table,
          Key: headKey(room),
          UpdateExpression: "SET #ln = :next, #lb = if_not_exists(#lb, :zero) + :bytes",
          ConditionExpression: "#op = :P AND #pe = :E AND #ln = :first",
          ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch", "#ln": "log_next_index", "#lb": "log_bytes" },
          ExpressionAttributeValues: { ":P": S(fence.pool), ":E": N(fence.epoch), ":first": N(first), ":next": N(first + entries.length), ":bytes": N(bytes), ":zero": N(0) },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
    ];
    /* The token is minted by `transactWrite`; the items carry it, so the request is built inside the token's scope. */
    const token = timing.token();
    lines.forEach((line, at) => {
      items.push({ Put: { TableName: table, Item: { ...key(gamePk(room), logSk(first + at)), line: S(line), att: S(token) }, ConditionExpression: "attribute_not_exists(pk)" } });
    });
    if (first === 0) items.push({ Put: { TableName: table, Item: { ...listKey("log", room), game_id: S(room) } } });
    const answer = await transactWrite(client, items, { ...timing, token: () => token });
    if (answer.kind === "applied") {
      validated.set(room, first + entries.length);
      return answer.redone ? { kind: "committed", redone: true } : COMMITTED;
    }
    if (answer.kind === "not-applied") return definite(`${answer.detail}; nothing was written`);
    if (needsSettling(answer) || answer.kind !== "refused") return settle(room, first, entries.length, answer);
    /* Refused on its first attempt: the HEAD term says whether this writer was fenced or the index moved. */
    validated.delete(room);
    const head = answer.reasons[0]?.code === "ConditionalCheckFailed" ? answer.reasons[0].item : null;
    if (answer.reasons[0]?.code === "ConditionalCheckFailed" && !headIsMine(head, fence)) return definite(FENCED);
    if (answer.reasons[0]?.code === "ConditionalCheckFailed") return definite(`${room}'s log moved to index ${headOf(head)?.log_next_index ?? "?"}; the batch at ${first} was not written`);
    return definite(`an entry already exists in the batch's range at index ${first} (the table was touched outside the protocol); nothing was written`);
  }

  return {
    loadLog: (room, options) => validatedLoad(room, options?.onProgress),
    appendBatch,
    async appendLog(room, entries) {
      throwUnlessCommitted(await appendBatch(room, entries));
    },

    async loadChat(room) {
      const out: RoomChatEntry[] = [];
      for (const item of await queryAll(client, table, gamePk(room), { prefix: CHAT_PREFIX, pageSize })) {
        try {
          out.push(JSON.parse(item.line?.S ?? "") as RoomChatEntry);
        } catch {
          /* chat is lossy by design (LIVE-3 §9.5): a line that cannot be read is skipped */
        }
      }
      return out;
    },

    async appendChat(room, entry) {
      if (!ROOM.test(room) || typeof entry?.id !== "string" || !CHAT_ID.test(entry.id) || !Number.isSafeInteger(entry.at) || entry.at < 0) throw new Error("not a chat line this store can key");
      /* ONE attempt, fenced inside the write: chat is lossy, so a failure is the caller's to count, never retried. */
      const answer = await transactWrite(
        client,
        [
          gameFence(table, room, fence),
          { Put: { TableName: table, Item: { ...key(gamePk(room), chatSk(entry.at, entry.id)), line: S(JSON.stringify(entry)) }, ConditionExpression: "attribute_not_exists(pk)" } },
        ],
        { ...timing, maxResends: 0 },
      );
      if (answer.kind === "applied") return;
      if (answer.kind === "refused" && answer.reasons[0]?.code === "ConditionalCheckFailed") throw new Error(`${FENCED} (the chat line was not written)`);
      if (answer.kind === "refused") return; // the same line is already stored (a duplicate delivery)
      if (answer.kind === "not-applied") throw new Error(`the chat line was not written (${answer.detail})`);
      throw new Error(`the chat line's outcome is unknown and it is not retried: chat is lossy (${answer.detail})`);
    },

    async listGameLogs() {
      return (await queryAll(client, table, listPk("log"), { pageSize }))
        .map((item) => item.sk?.S ?? "")
        .filter((room) => GAME_LOG.test(room))
        .sort();
    },

    async readHead(room) {
      const [head, zero] = await Promise.all([getItem(client, table, headKey(room)), getItem(client, table, key(gamePk(room), logSk(0)))]);
      if (zero === null) return { present: false, size: 0, first: null };
      const parsed = typeof zero.line?.S === "string" ? parseEntryLine(zero.line.S) : null;
      return { present: true, size: headOf(head)?.log_bytes ?? 0, first: parsed === null ? undefined : parsed.entry };
    },

    /* The export is the VALIDATED log: a damaged or another build's log is refused (StoreCorruptError /
       StoreIncompatibleError), never exported as if it were history. */
    async exportLog(room) {
      const { lines } = await validatedRead(room);
      return Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8");
    },
  };
}
