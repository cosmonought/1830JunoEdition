// server/src/persistence/conformance/dynamoProofFinancialStore.ts
//
// ==================================================================
//  LIVE-5 L5-1: A PROOF ADAPTER -- NOT A PRODUCTION STORE, NOT THE L5-2 DESIGN
// ==================================================================
//
// This exists for one reason: to show that the conformance harness really runs against DynamoDB Local, and that the
// cases can express what a DynamoDB adapter must do and a file store cannot (the fence evaluated INSIDE the write, an
// idempotent resend, paged listings). It implements the smallest port with every interesting property -- the financial
// record: create-if-absent, compare-and-swap, "conflict carries the current record", classified unreadable values that
// are never overwritten -- over a single test table. It lives beside the conformance suites, is imported only by them,
// and must never be wired into a server: L5-2 builds the real game-table adapters (the `HEAD` fence per game, the pool
// epoch, `FINIDX#` / `FINKEYS`, size assertions, the 8-minute resend bound) from the architecture preflight §3-§5.
//
// What it does, briefly:
//   item        pk `GAME#<id>`, sk `FIN`; `body` is the record's JSON text exactly as the file store writes it (so
//               `financialRecordFormat` classifies both the same way), `record_version` beside it.
//   fence       pk `FENCE`, sk `FENCE`, `epoch`. Every write is ONE TransactWriteItems: ConditionCheck on the fence
//               (`epoch = :mine`) + the conditional Put. A stale writer is refused by DynamoDB itself.
//   CAS         put: the Put is conditioned on the body the adapter read AND its version -- never an overwrite of a
//               value it did not see (an unreadable body is refused before any write).
//   outcomes    success -> committed. TransactionCanceled: the fence term -> definite ("fenced"); the item term ->
//               re-read (create converges on the existing record; put answers conflict with the current one). A
//               service rejection (throttling, validation, transaction conflict) -> definite. Anything else (a timeout,
//               a network error, a 5xx) is UNKNOWN: the identical request is resent ONCE with the SAME
//               ClientRequestToken; if that resend is refused by a condition, a strong read settles it by the
//               ATTEMPT TOKEN the write stamped on the item (`attempt`), never by comparing bodies -- ours is there ->
//               committed (redone); otherwise the fence verdict, then the conflict/definite answer; a resend the service
//               refused without evaluating it, or that was unknown again -> uncertain.
//   limits      one resend, where the preflight (§4) asks for resends until definite within the token's 10-minute window
//               (stopping at ~8 minutes) and a wait-and-resend on TransactionInProgress. L5-2 builds that; this proof
//               only has to show the harness can tell the difference.

import { randomUUID } from "crypto";
import { GetItemCommand, ScanCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../../aws/awsClients";
import { financialRecordFormat, FinancialRecordUnreadableError, type FinancialGameStore, type FinancialPutOutcome, type UnreadableFormat } from "../../escrow/financialGameStore";
import { isFinancialGameRecord, type FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { GAME_ID_PATTERN } from "../../rooms/gameRecord";
import { COMMITTED, type StoreWriteOutcome } from "../storeResult";

const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
export const FENCE_KEY = { pk: S("FENCE"), sk: S("FENCE") };
const finKey = (gameId: string) => ({ pk: S(`GAME#${gameId}`), sk: S("FIN") });

/** Service answers that mean "the request was refused; nothing was applied". */
const DEFINITE_ERRORS = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ValidationException",
  "ResourceNotFoundException",
  "TransactionConflictException",
  "IdempotentParameterMismatchException",
  "ConditionalCheckFailedException",
]);

type Attempt =
  | { readonly kind: "ok" }
  | { readonly kind: "cancelled"; readonly fenced: boolean }
  | { readonly kind: "definite"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export interface ProofFinancialStoreOptions {
  /** The writer epoch this instance carries into every write's fence condition. */
  readonly epoch: number;
  /** Scan page size (small in the conformance run, to force paging). */
  readonly pageSize?: number;
}

export function createDynamoProofFinancialStore(client: DynamoDBClient, table: string, options: ProofFinancialStoreOptions): FinancialGameStore {
  const pageSize = options.pageSize ?? 100;

  async function readItem(gameId: string): Promise<{ readonly body: string; readonly attempt: string | null } | null> {
    const answer = await client.send(new GetItemCommand({ TableName: table, Key: finKey(gameId), ConsistentRead: true }), { abortSignal: deadline() });
    const body = answer.Item?.body?.S;
    return body === undefined ? null : { body, attempt: answer.Item?.attempt?.S ?? null };
  }
  const readBody = async (gameId: string): Promise<string | null> => (await readItem(gameId))?.body ?? null;

  function classify(gameId: string, body: string): FinancialGameRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new FinancialRecordUnreadableError(`the financial record of ${gameId} is not JSON`, gameId);
    }
    const format = financialRecordFormat(parsed, gameId);
    if (format !== "current") throw new FinancialRecordUnreadableError(`the financial record of ${gameId} is ${format}; never overwritten`, gameId, format as UnreadableFormat);
    return parsed as FinancialGameRecord;
  }

  async function transact(items: TransactWriteItem[], token: string): Promise<Attempt> {
    try {
      await client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: token }), { abortSignal: deadline() });
      return { kind: "ok" };
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name === "TransactionCanceledException") {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons[0]?.Code === "ConditionalCheckFailed") return { kind: "cancelled", fenced: true };
        if (reasons[1]?.Code === "ConditionalCheckFailed") return { kind: "cancelled", fenced: false };
        return { kind: "definite", detail: describe(error) }; // e.g. a TransactionConflict on one item
      }
      if (DEFINITE_ERRORS.has(name)) return { kind: "definite", detail: describe(error) };
      return { kind: "unknown", detail: describe(error) };
    }
  }

  const fenceCheck = (): TransactWriteItem => ({
    ConditionCheck: { TableName: table, Key: FENCE_KEY, ConditionExpression: "#e = :e", ExpressionAttributeNames: { "#e": "epoch" }, ExpressionAttributeValues: { ":e": N(options.epoch) } },
  });

  /** One write: sent, resent once with the same token if the outcome was unknown, then settled by a strong read of the
   *  attempt token the Put stamps on the item. */
  async function write(gameId: string, put: TransactWriteItem, onItemRefused: () => Promise<StoreWriteOutcome | FinancialPutOutcome>): Promise<StoreWriteOutcome | FinancialPutOutcome> {
    const token = randomUUID();
    const stamped: TransactWriteItem = { Put: { ...(put.Put as NonNullable<TransactWriteItem["Put"]>), Item: { ...(put.Put?.Item ?? {}), attempt: S(token) } } };
    const items = [fenceCheck(), stamped];
    const first = await transact(items, token);
    if (first.kind === "ok") return COMMITTED;
    if (first.kind === "definite") return { kind: "definite", detail: first.detail };
    if (first.kind === "cancelled") return first.fenced ? { kind: "definite", detail: "fenced: a newer writer holds the epoch; nothing was written" } : onItemRefused();
    const resend = await transact(items, token);
    if (resend.kind === "ok") return { kind: "committed", redone: true };
    if (resend.kind === "unknown") return { kind: "uncertain", detail: `${first.detail}; the resend was unknown too: ${resend.detail}` };
    /* A condition refused the resend: the first attempt may have landed. The strong read decides. */
    let stored: { readonly attempt: string | null } | null;
    try {
      stored = await readItem(gameId);
    } catch (error) {
      return { kind: "uncertain", detail: `${first.detail}; the settling read failed: ${describe(error)}` };
    }
    if (stored?.attempt === token) return { kind: "committed", redone: true };
    /* A resend the service refused without evaluating it (throttling...) proves nothing about the first attempt. */
    if (resend.kind === "definite") return { kind: "uncertain", detail: `${first.detail}; the resend was refused (${resend.detail}) and our write is not visible` };
    if (resend.fenced) return { kind: "definite", detail: "fenced: a newer writer holds the epoch; nothing of ours is stored" };
    return onItemRefused();
  }

  return {
    async list() {
      const out: string[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new ScanCommand({ TableName: table, ConsistentRead: true, Limit: pageSize, FilterExpression: "sk = :fin", ExpressionAttributeValues: { ":fin": S("FIN") }, ExclusiveStartKey: start }),
          { abortSignal: deadline() },
        );
        for (const item of page.Items ?? []) out.push((item.pk?.S ?? "").slice("GAME#".length));
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
      return out.sort();
    },

    async load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return null;
      const body = await readBody(gameId);
      return body === null ? null : classify(gameId, body);
    },

    async create(record) {
      if (!GAME_ID_PATTERN.test(record.game_id) || !isFinancialGameRecord(record) || record.record_version !== 1) return { outcome: { kind: "definite", detail: "not a new financial record" }, existing: null };
      const existingOf = async (): Promise<{ outcome: StoreWriteOutcome; existing: FinancialGameRecord | null }> => {
        const stored = await readBody(record.game_id);
        if (stored === null) return { outcome: { kind: "definite", detail: "the create was refused and no record is stored" }, existing: null };
        try {
          return { outcome: COMMITTED, existing: classify(record.game_id, stored) };
        } catch (error) {
          return { outcome: { kind: "definite", detail: `${describe(error)}; it is never overwritten` }, existing: null };
        }
      };
      const current = await readBody(record.game_id);
      if (current !== null) return existingOf();
      const body = JSON.stringify(record);
      const put: TransactWriteItem = { Put: { TableName: table, Item: { ...finKey(record.game_id), body: S(body), record_version: N(1) }, ConditionExpression: "attribute_not_exists(pk)" } };
      const box: { converged: { outcome: StoreWriteOutcome; existing: FinancialGameRecord | null } | null } = { converged: null };
      const outcome = await write(record.game_id, put, async () => {
        box.converged = await existingOf();
        return box.converged.outcome;
      });
      return box.converged ?? { outcome: outcome as StoreWriteOutcome, existing: null };
    },

    async put(next, expectedVersion) {
      const conflictOrDefinite = async (): Promise<FinancialPutOutcome> => {
        const stored = await readBody(next.game_id);
        if (stored === null) return { kind: "conflict", current: null };
        try {
          return { kind: "conflict", current: classify(next.game_id, stored) };
        } catch (error) {
          return { kind: "definite", detail: `${describe(error)}; it is never overwritten` };
        }
      };
      const observed = await readBody(next.game_id);
      if (observed === null) return { kind: "conflict", current: null };
      let current: FinancialGameRecord;
      try {
        current = classify(next.game_id, observed);
      } catch (error) {
        return { kind: "definite", detail: `${describe(error)}; it is never overwritten` };
      }
      if (current.record_version !== expectedVersion) return { kind: "conflict", current };
      if (!isFinancialGameRecord(next) || next.game_id !== current.game_id || next.record_version !== expectedVersion + 1) return { kind: "definite", detail: "not the next version of the record" };
      const body = JSON.stringify(next);
      const put: TransactWriteItem = {
        Put: {
          TableName: table,
          Item: { ...finKey(next.game_id), body: S(body), record_version: N(next.record_version) },
          ConditionExpression: "#b = :observed AND #v = :expected",
          ExpressionAttributeNames: { "#b": "body", "#v": "record_version" },
          ExpressionAttributeValues: { ":observed": S(observed), ":expected": N(expectedVersion) },
        },
      };
      return (await write(next.game_id, put, conflictOrDefinite)) as FinancialPutOutcome;
    },
  };
}
