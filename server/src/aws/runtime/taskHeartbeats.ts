// server/src/aws/runtime/taskHeartbeats.ts
//
// ==================================================================
//  LIVE-6 FINAL CONVERGENCE (L6-5A/L6-5B x L6-6R): THE OLD GENERATION'S `TASK#` HEARTBEATS AFTER A RESTORE'S STOP --
//  DIAGNOSTIC EVIDENCE FOR THE STAGING CERTIFICATION, NEVER A LEASE
// ==================================================================
//
// The preflight's §17.2 step 1 has the operator confirm, before a restore is adopted, that no ECS task of any pool runs AND
// that no `TASK#` heartbeat is fresh. L6-6R's restore-quiet gate proves the first from ECS's own listing (every pool
// drained, every task in the cluster STOPPED, desired RUNNING and desired STOPPED); this reader supplies the second as
// OPERATOR PROOF (`HeartbeatEvidence.oldGenerationAfterStop`):
//
//   for a restore from generation N to N+1, read the PREVIOUS generation's game table (`gs-<env>-game-g<N>`: a straggler of
//   generation N writes its heartbeat into its own configured table) with a STRONGLY CONSISTENT, PAGINATED Scan filtered to
//   `TASK#` items; decode every one with the canonical decoder (`taskStatus.ts`); report the task ids whose `generation` is
//   N and whose `updated_at` is LATER than the restore-stop capture's `captured_at`.
//
//   - a fresh old-generation heartbeat = restore-quiet FAIL (a process of the old generation was alive after the stop);
//   - NO heartbeat proves nothing (a task that exits at once writes nothing more): ECS's task/service capture remains the
//     shutdown proof, never this;
//   - TASK# never becomes a lease: nothing in the runtime reads this, and no takeover, claim, routing or readiness
//     decision may (the L6-5A source guard, widened for exactly this file, which only `tools/awsDeploy.ts` imports);
//   - copied TASK# items in the restored g<N+1> are irrelevant (their `updated_at` predates the restore point): only
//     g<N> is read;
//   - an item the decoder cannot read, or a read that fails part-way, THROWS: an unreadable table is never "no heartbeat".
//
// IAM: the certifier / verifier role (`gs-<env>-bootstrap`) gets `dynamodb:Scan` on the NON-serving managed generations
// only (infra/aws/modules/app/iam.tf `RestoreQuietOldGenerationHeartbeats`); no runtime task gains any authority.

import { GetItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { decodeTaskStatusItem, TASK_STATUS_SK, taskStatusKey, type TaskStatusRecord } from "./taskStatus";

/** The key prefix every heartbeat item's partition carries (`taskStatusPk`). */
const TASK_PREFIX = "TASK#";
/** A bound on pages, never on completeness: a table with more pages is refused, not cut. */
export const HEARTBEAT_SCAN_MAX_PAGES = 100_000;

export class TaskHeartbeatsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskHeartbeatsUnreadableError";
  }
}

/** Every `TASK#` item of `table`: strongly consistent, every page, each decoded strictly (one it cannot read: throws). */
export async function scanTaskHeartbeats(client: DynamoDBClient, table: string, options: { readonly pageSize?: number } = {}): Promise<TaskStatusRecord[]> {
  const out: TaskStatusRecord[] = [];
  let start: Record<string, AttributeValue> | undefined;
  let pages = 0;
  do {
    if (pages >= HEARTBEAT_SCAN_MAX_PAGES) throw new TaskHeartbeatsUnreadableError(`${table}: more than ${HEARTBEAT_SCAN_MAX_PAGES} scan pages; refusing an unbounded read`);
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        ConsistentRead: true,
        FilterExpression: "begins_with(#pk, :prefix) AND #sk = :sk",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":prefix": { S: TASK_PREFIX }, ":sk": { S: TASK_STATUS_SK } },
        ExclusiveStartKey: start,
        ...(options.pageSize === undefined ? {} : { Limit: options.pageSize }), // tests: force many pages
      }),
      { abortSignal: deadline() },
    );
    pages += 1;
    for (const item of page.Items ?? []) {
      const decoded = decodeTaskStatusItem(item);
      if ("problem" in decoded) throw new TaskHeartbeatsUnreadableError(`${table}: ${decoded.problem}`);
      out.push(decoded);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/**
 * The task ids of generation `generation` whose heartbeat was written AFTER `after` (ms; the restore-stop capture's
 * `captured_at`), read from that generation's own game table. Sorted, deduplicated. Throws when the table cannot be read
 * completely or an item cannot be decoded.
 */
export async function oldGenerationHeartbeatsAfter(client: DynamoDBClient, table: string, expect: { readonly generation: number; readonly after: number }, options: { readonly pageSize?: number } = {}): Promise<string[]> {
  if (!Number.isSafeInteger(expect.generation) || expect.generation < 1) throw new TaskHeartbeatsUnreadableError(`generation ${String(expect.generation)} is not a generation`);
  if (!Number.isFinite(expect.after)) throw new TaskHeartbeatsUnreadableError("no restore-stop time to compare the heartbeats with");
  const records = await scanTaskHeartbeats(client, table, options);
  return [...new Set(records.filter((r) => r.generation === expect.generation && r.updatedAt > expect.after).map((r) => r.task))].sort();
}

/**
 * LIVE-6 relayer rotation: ONE task's `TASK#` item, read strongly (GetItem, ConsistentRead) from the SERVING game table,
 * decoded by the canonical decoder -- for the staging certification's post-rotation proof (the relayer-role holder's own
 * statement that its relayer is `usable` and its escrow `active`). `null`: the task never wrote one (or its TTL removed
 * it). An item the decoder cannot read THROWS (`TaskHeartbeatsUnreadableError`): never "no heartbeat", never "usable".
 * Operator evidence after the fact, judged beside the authoritative pool item, mirror and ledger fence; never a lease, and
 * nothing in the runtime reads it (the L6-5A source guard).
 */
export async function readTaskStatus(client: DynamoDBClient, table: string, task: string): Promise<TaskStatusRecord | null> {
  if (!/^[\x21-\x7e]{1,128}$/.test(task)) throw new TaskHeartbeatsUnreadableError(`${JSON.stringify(task.slice(0, 40))} is not a task id`);
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: taskStatusKey(task), ConsistentRead: true }), { abortSignal: deadline() });
  if (answer.Item === undefined) return null;
  const decoded = decodeTaskStatusItem(answer.Item);
  if ("problem" in decoded) throw new TaskHeartbeatsUnreadableError(`${table}: ${decoded.problem}`);
  if (decoded.task !== task) throw new TaskHeartbeatsUnreadableError(`${table}: TASK#${task} names task ${decoded.task}`);
  return decoded;
}
