// server/src/aws/deploy/staging/transactionProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 §4: THE REAL SERVICE'S TRANSACTION SEMANTICS -- WHAT L5-2 / L5-3 ASSUME, ON DISPOSABLE STAGING ITEMS
// ==================================================================
//
// The L5-2 write engine (`aws/game/transact.ts`) and every fence built on it assume four things about DynamoDB that
// mocks and DynamoDB Local cannot fully establish. This probe exercises each against the REAL table, as the task role,
// through the engine's OWN code (`transactWrite`, `classifyTransactFailure`) -- the engine is not changed or weakened:
//
//   T1 CONDITION INSIDE A TRANSACTION   a failed ConditionCheck cancels the whole TransactWriteItems: the other action
//                                       is not applied, the reasons align with the actions, ALL_OLD returns the item
//   T2 COMPETING CONDITIONAL WRITES     two concurrent writes with the same precondition: exactly one applies; the other
//                                       is refused by its condition or cancelled by a conflict -- never both
//   T3 TRANSACTION CONFLICT             concurrent transactions on one item: some are cancelled `TransactionConflict`,
//                                       the engine classifies each as not-applied, and the item counts exactly the
//                                       successes (a conflict never applied anything)
//   T4 SAME-TOKEN RESEND (lost answer)  a request applied once, its answer "lost", resent with the SAME token: success,
//                                       applied ONCE (a new token is refused -- the condition really fails now); the
//                                       same token with other parameters is IdempotentParameterMismatch; a refused
//                                       original resent with its token is evaluated again and refused
//
// SAFETY. It writes ONLY when asked (`--disposable-writes L6CERT#<run>`, the exact partition, typed out) and ONLY the
// one partition `L6CERT#<run>` of the game table -- a partition no production path reads (`evidence.ts`). Every request
// goes through `disposableOnly`, which refuses (before sending) any key, table or command outside that partition; the
// L5-2 fences, SYSTEM, POOL#, GAME# and the ledger are unreachable from here. A run id already holding items is refused
// (and left alone). The cleanup always runs, deletes every item of the partition, and reads it back empty; anything left
// is named in the record and FAILS the section.

import { randomUUID } from "crypto";
import {
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";

import { deadline } from "../../awsClients";
import { classifyTransactFailure, resendTiming, transactWrite, type ResendTiming, type WriteAnswer } from "../../game/transact";
import type { Check } from "../deployVerify";
import { arr, disposablePartition, judge, num, obj, str } from "./evidence";

type Item = Record<string, AttributeValue>;
const S = (v: string): AttributeValue => ({ S: v });
const N = (v: number): AttributeValue => ({ N: String(v) });

export class DisposableGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisposableGuardError";
  }
}

/* ------------------------------------------------------------------ */
/* The guard                                                            */
/* ------------------------------------------------------------------ */

const keysOfCommand = (command: unknown): { readonly name: string; readonly tables: string[]; readonly pks: string[] } => {
  const name = (command as { constructor?: { name?: string } })?.constructor?.name ?? "?";
  const input = obj((command as { input?: unknown })?.input);
  const tables: string[] = [];
  const pks: string[] = [];
  const add = (table: unknown, k: unknown) => {
    tables.push(String(table));
    pks.push(String(obj(obj(k).pk).S));
  };
  if (name === "TransactWriteItemsCommand") {
    for (const raw of arr(input.TransactItems)) {
      const item = obj(raw);
      const action = obj(item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck);
      add(action.TableName, item.Put !== undefined ? action.Item : action.Key);
    }
  } else if (name === "PutItemCommand") add(input.TableName, input.Item);
  else if (name === "DeleteItemCommand" || name === "UpdateItemCommand" || name === "GetItemCommand") add(input.TableName, input.Key);
  else if (name === "QueryCommand") {
    tables.push(String(input.TableName));
    const values = obj(input.ExpressionAttributeValues);
    pks.push(input.KeyConditionExpression === "pk = :pk" ? String(obj(values[":pk"]).S) : "(not a single-partition query)");
  } else pks.push(`(${name} is not a probe command)`);
  return { name, tables, pks };
};

/** A client that refuses, BEFORE sending, anything outside `table` / `pk` -- the only one this probe is ever given. */
export function disposableOnly(client: DynamoDBClient, table: string, pk: string): DynamoDBClient {
  const send = (command: unknown, options?: unknown) => {
    const seen = keysOfCommand(command);
    const bad = seen.tables.some((t) => t !== table) || seen.pks.length === 0 || seen.pks.some((p) => p !== pk);
    if (bad) return Promise.reject(new DisposableGuardError(`refused before sending: ${seen.name} on ${seen.tables.join(",")} [${seen.pks.join(",")}] is outside ${table} ${pk}`));
    return (client.send as (c: unknown, o?: unknown) => Promise<unknown>)(command, options);
  };
  return { send } as unknown as DynamoDBClient;
}

/* ------------------------------------------------------------------ */
/* The probe                                                            */
/* ------------------------------------------------------------------ */

export interface TransactionProbeContext {
  readonly run: string;
  readonly gameTable: string;
  /** T3: rounds of concurrent writers (a conflict must be observed at least once). */
  readonly conflictRounds: number;
  readonly conflictWriters: number;
  /** The engine's timing (production's by default, its window shortened to one minute). */
  readonly timing?: Partial<ResendTiming>;
}

const errorName = (error: unknown): string => (error as { name?: string } | null)?.name ?? "Error";

/** What one engine answer records (codes and kinds, never an item's content beyond the probe's own numbers). */
const answerRecord = (answer: WriteAnswer) => ({
  kind: answer.kind,
  ...(answer.kind === "applied" ? { redone: answer.redone } : {}),
  ...(answer.kind === "refused" ? { resend: answer.resend, reasons: answer.reasons.map((r) => r.code), old_v: answer.reasons.map((r) => (r.item?.v?.N === undefined ? null : Number(r.item.v.N))) } : {}),
  ...(answer.kind === "not-applied" || answer.kind === "unknown" ? { detail: answer.detail.slice(0, 200) } : {}),
});

export async function runTransactionProbe(rawClient: DynamoDBClient, ctx: TransactionProbeContext): Promise<Record<string, unknown>> {
  const pk = disposablePartition(ctx.run);
  const table = ctx.gameTable;
  const client = disposableOnly(rawClient, table, pk);
  const timing = resendTiming({ windowMs: 60_000, ...(ctx.timing ?? {}) });
  const k = (sk: string): Item => ({ pk: S(pk), sk: S(sk) });
  const read = async (sk: string): Promise<Item | null> => (await client.send(new GetItemCommand({ TableName: table, Key: k(sk), ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;
  const listKeys = async (): Promise<string[]> => {
    const out: string[] = [];
    let start: Item | undefined;
    for (let page = 0; page < 20; page += 1) {
      const answer = await client.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": S(pk) }, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }), { abortSignal: deadline() });
      for (const item of answer.Items ?? []) out.push(String(item.sk?.S));
      start = answer.LastEvaluatedKey;
      if (start === undefined) break;
    }
    return out;
  };
  const create = (sk: string, attributes: Item): TransactWriteItem => ({ Put: { TableName: table, Item: { ...k(sk), ...attributes }, ConditionExpression: "attribute_not_exists(pk)" } });

  const before = await listKeys();
  if (before.length > 0) {
    return { refused: `the partition ${pk} already holds ${before.length} item(s): this run id was used before (it is left untouched; choose a new run id)`, preexisting: before.length };
  }

  const record: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    /* T1 */
    try {
      const setup = await transactWrite(client, [create("T1-A", { v: N(1) })], timing);
      const probe = await transactWrite(
        client,
        [
          { ConditionCheck: { TableName: table, Key: k("T1-A"), ConditionExpression: "#v = :two", ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":two": N(2) }, ReturnValuesOnConditionCheckFailure: "ALL_OLD" } },
          create("T1-B", { v: N(1) }),
        ],
        timing,
      );
      record.t1 = { setup: answerRecord(setup), probe: answerRecord(probe), b_present: (await read("T1-B")) !== null };
    } catch (error) {
      errors.push(`T1: ${errorName(error)}`);
    }

    /* T2 */
    try {
      const setup = await transactWrite(client, [create("T2", { v: N(1) })], timing);
      const competing = (who: string): TransactWriteItem[] => [
        { Update: { TableName: table, Key: k("T2"), UpdateExpression: "SET #v = :two, #w = :who", ConditionExpression: "#v = :one", ExpressionAttributeNames: { "#v": "v", "#w": "w" }, ExpressionAttributeValues: { ":one": N(1), ":two": N(2), ":who": S(who) } } },
      ];
      const [a, b] = await Promise.all([transactWrite(client, competing("a"), timing), transactWrite(client, competing("b"), timing)]);
      const after = await read("T2");
      record.t2 = { setup: answerRecord(setup), a: answerRecord(a), b: answerRecord(b), final_v: after?.v?.N === undefined ? null : Number(after.v.N), final_w: after?.w?.S ?? null };
    } catch (error) {
      errors.push(`T2: ${errorName(error)}`);
    }

    /* T3 */
    try {
      const setup = await transactWrite(client, [create("T3", { n: N(0) })], timing);
      const add: TransactWriteItem[] = [{ Update: { TableName: table, Key: k("T3"), UpdateExpression: "ADD #n :one", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#n": "n" }, ExpressionAttributeValues: { ":one": N(1) } } }];
      let applied = 0;
      let conflicts = 0;
      let conflictsClassifiedNotApplied = 0;
      const other: Record<string, number> = {};
      for (let round = 0; round < ctx.conflictRounds; round += 1) {
        const outcomes = await Promise.all(
          Array.from({ length: ctx.conflictWriters }, () =>
            client.send(new TransactWriteItemsCommand({ TransactItems: add }), { abortSignal: deadline() }).then(
              () => null,
              (error: unknown) => error,
            ),
          ),
        );
        for (const outcome of outcomes) {
          if (outcome === null) {
            applied += 1;
            continue;
          }
          const sent = classifyTransactFailure(outcome);
          const isConflict = sent.kind === "not-applied" && sent.conflict;
          if (isConflict) {
            conflicts += 1;
            conflictsClassifiedNotApplied += 1;
          } else {
            const reasonCodes = ((outcome as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((r) => r.Code ?? "None");
            const label = `${errorName(outcome)}${reasonCodes.length > 0 ? `[${reasonCodes.join(",")}]` : ""}->${sent.kind}`;
            other[label] = (other[label] ?? 0) + 1;
          }
        }
      }
      const after = await read("T3");
      record.t3 = { setup: answerRecord(setup), rounds: ctx.conflictRounds, writers: ctx.conflictWriters, applied, conflicts, conflicts_classified_not_applied: conflictsClassifiedNotApplied, other, final_n: after?.n?.N === undefined ? null : Number(after.n.N) };
    } catch (error) {
      errors.push(`T3: ${errorName(error)}`);
    }

    /* T4 */
    try {
      const setup = await transactWrite(client, [create("T4", { v: N(1), n: N(0) })], timing);
      const token = randomUUID();
      const items: TransactWriteItem[] = [
        { Update: { TableName: table, Key: k("T4"), UpdateExpression: "SET #v = :two ADD #n :one", ConditionExpression: "#v = :one", ExpressionAttributeNames: { "#v": "v", "#n": "n" }, ExpressionAttributeValues: { ":one": N(1), ":two": N(2) } } },
      ];
      let original: string;
      try {
        await client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: token }), { abortSignal: deadline() });
        original = "applied";
      } catch (error) {
        original = errorName(error);
      }
      /* The original's answer is "lost": the engine resends the IDENTICAL request under the SAME token. */
      const resend = await transactWrite(client, items, { ...timing, token: () => token });
      const control = await transactWrite(client, items, timing); // a NEW token: the condition really fails now
      let mismatch: string;
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: [{ Update: { TableName: table, Key: k("T4"), UpdateExpression: "SET #v = :three", ConditionExpression: "#v = :one", ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":one": N(1), ":three": N(3) } } }],
            ClientRequestToken: token,
          }),
          { abortSignal: deadline() },
        );
        mismatch = "applied";
      } catch (error) {
        mismatch = errorName(error);
      }
      /* A REFUSED original resent with its token is evaluated again (and refused again). */
      const refusedToken = randomUUID();
      const refusedItems: TransactWriteItem[] = [{ Update: { TableName: table, Key: k("T4"), UpdateExpression: "SET #v = :nine", ConditionExpression: "#v = :one", ExpressionAttributeNames: { "#v": "v" }, ExpressionAttributeValues: { ":one": N(1), ":nine": N(9) } } }];
      let refusedOriginal: string;
      try {
        await client.send(new TransactWriteItemsCommand({ TransactItems: refusedItems, ClientRequestToken: refusedToken }), { abortSignal: deadline() });
        refusedOriginal = "applied";
      } catch (error) {
        refusedOriginal = errorName(error);
      }
      const refusedResend = await transactWrite(client, refusedItems, { ...timing, token: () => refusedToken });
      const after = await read("T4");
      record.t4 = {
        setup: answerRecord(setup),
        original,
        same_token_resend: answerRecord(resend),
        new_token_control: answerRecord(control),
        mismatch,
        mismatch_engine_class: mismatch === "applied" ? "applied" : classifyTransactFailure({ name: mismatch }).kind,
        refused_original: refusedOriginal,
        refused_resend: answerRecord(refusedResend),
        final_v: after?.v?.N === undefined ? null : Number(after.v.N),
        final_n: after?.n?.N === undefined ? null : Number(after.n.N),
      };
    } catch (error) {
      errors.push(`T4: ${errorName(error)}`);
    }
  } finally {
    /* The cleanup always runs: every item of the partition, then read back. */
    const cleanup: Record<string, unknown> = { deleted: 0, remaining: null as number | null, errors: [] as string[] };
    try {
      for (const sk of await listKeys()) {
        try {
          await client.send(new DeleteItemCommand({ TableName: table, Key: k(sk) }), { abortSignal: deadline() });
          cleanup.deleted = Number(cleanup.deleted) + 1;
        } catch (error) {
          (cleanup.errors as string[]).push(`${sk}: ${errorName(error)}`);
        }
      }
      const left = await listKeys();
      cleanup.remaining = left.length;
      if (left.length > 0) cleanup.left = left;
    } catch (error) {
      (cleanup.errors as string[]).push(`listing: ${errorName(error)}`);
    }
    record.cleanup = cleanup;
    record.errors = errors;
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* Judgement (pure; the certification re-judges the record)            */
/* ------------------------------------------------------------------ */

export function judgeTransactionProbe(section: unknown): Check[] {
  const s = obj(section);
  if (s.status === "not-run") return [judge("transactions", false, "", `not run (${String(s.reason ?? "no --disposable-writes")}): the transaction gate is required`)];
  const r = obj(s.results);
  if (typeof r.refused === "string") return [judge("transactions: a fresh run", false, "", r.refused)];
  const checks: Check[] = [];
  const errors = arr(r.errors).map(String);
  checks.push(judge("transactions: every test ran", errors.length === 0 && ["t1", "t2", "t3", "t4"].every((t) => r[t] !== undefined), "T1-T4", `errors [${errors.join("; ")}]`));

  const t1 = obj(r.t1);
  const t1p = obj(t1.probe);
  checks.push(
    judge(
      "T1 a failed ConditionCheck cancels the whole transaction",
      obj(t1.setup).kind === "applied" && t1p.kind === "refused" && t1p.resend === false && JSON.stringify(t1p.reasons) === JSON.stringify(["ConditionalCheckFailed", "None"]) && arr(t1p.old_v)[0] === 1 && t1.b_present === false,
      "refused [ConditionalCheckFailed, None], ALL_OLD returned v=1, the other Put not applied",
      `setup ${String(obj(t1.setup).kind)}, probe ${JSON.stringify(t1p)}, second item present ${String(t1.b_present)}`,
    ),
  );

  const t2 = obj(r.t2);
  const kinds = [obj(t2.a).kind, obj(t2.b).kind];
  const winner = kinds[0] === "applied" ? "a" : kinds[1] === "applied" ? "b" : null;
  const loser = obj(winner === "a" ? t2.b : t2.a);
  const loserOk = loser.kind === "refused" || (loser.kind === "not-applied" && /TransactionConflict/.test(String(loser.detail)));
  checks.push(
    judge(
      "T2 competing conditional writes: exactly one applies",
      obj(t2.setup).kind === "applied" && kinds.filter((x) => x === "applied").length === 1 && loserOk && t2.final_v === 2 && t2.final_w === winner,
      `${String(winner)} applied; the other ${String(loser.kind)}; the item holds the winner's write`,
      `answers [${kinds.join(", ")}], final v ${String(t2.final_v)} w ${String(t2.final_w)}`,
    ),
  );

  const t3 = obj(r.t3);
  const applied = num(t3.applied);
  const conflicts = num(t3.conflicts) ?? 0;
  const otherKinds = Object.keys(obj(t3.other));
  const unknownOther = otherKinds.filter((label) => /->(unknown|in-progress)$/.test(label));
  checks.push(
    judge(
      "T3 TransactionConflict is observed and classified not-applied",
      conflicts >= 1 && t3.conflicts_classified_not_applied === conflicts,
      `${conflicts} conflict(s) in ${String(t3.rounds)}x${String(t3.writers)} writes, each classified not-applied by the engine`,
      conflicts === 0 ? `no conflict in ${String(t3.rounds)}x${String(t3.writers)} concurrent writes: not established (raise --conflict-rounds / --conflict-writers)` : `${String(t3.conflicts_classified_not_applied)} of ${conflicts} classified not-applied`,
    ),
  );
  checks.push(
    judge(
      "T3 a conflict never applied anything",
      applied !== null && t3.final_n === applied && unknownOther.length === 0 && obj(t3.setup).kind === "applied",
      `the item counts exactly the ${String(applied)} successes`,
      `the item holds ${String(t3.final_n)} after ${String(applied)} successes${unknownOther.length > 0 ? `; unknown outcomes [${unknownOther.join(", ")}] (nothing is concluded)` : ""}`,
    ),
  );

  const t4 = obj(r.t4);
  const resend = obj(t4.same_token_resend);
  const control = obj(t4.new_token_control);
  const refusedResend = obj(t4.refused_resend);
  checks.push(
    judge(
      "T4 a lost answer resent with the same token is the original's success, applied once",
      obj(t4.setup).kind === "applied" && t4.original === "applied" && resend.kind === "applied" && control.kind === "refused" && t4.final_v === 2 && t4.final_n === 1,
      "same token: success; a new token: refused (the condition fails now); the counter moved once",
      `original ${String(t4.original)}, same-token ${String(resend.kind)}, new-token ${String(control.kind)}, final v ${String(t4.final_v)} n ${String(t4.final_n)}`,
    ),
  );
  checks.push(
    judge(
      "T4 the same token with other parameters is IdempotentParameterMismatch (the engine: unknown, settled by a read)",
      t4.mismatch === "IdempotentParameterMismatchException" && t4.mismatch_engine_class === "unknown",
      "IdempotentParameterMismatchException -> unknown",
      `${String(t4.mismatch)} -> ${String(t4.mismatch_engine_class)}`,
    ),
  );
  checks.push(
    judge(
      "T4 a refused original resent with its token is evaluated again",
      t4.refused_original === "TransactionCanceledException" && refusedResend.kind === "refused" && t4.final_v === 2,
      "refused, then refused again; nothing applied",
      `original ${String(t4.refused_original)}, resend ${String(refusedResend.kind)}, final v ${String(t4.final_v)}`,
    ),
  );

  const cleanup = obj(r.cleanup);
  checks.push(
    judge(
      "transactions: cleanup",
      cleanup.remaining === 0 && arr(cleanup.errors).length === 0,
      `${String(cleanup.deleted)} disposable item(s) deleted; the partition reads back empty`,
      `remaining ${String(cleanup.remaining)} [${arr(cleanup.left).map(String).join(", ")}], errors [${arr(cleanup.errors).map(String).join("; ")}] (disposable ${str(s.partition) ?? "L6CERT#<run>"} items only)`,
    ),
  );
  return checks;
}
