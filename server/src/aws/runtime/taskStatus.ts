// server/src/aws/runtime/taskStatus.ts
//
// ==================================================================
//  LIVE-6 L6-5A: THE `TASK#` STATUS ITEM -- A TASK'S OWN DIAGNOSTIC HEARTBEAT IN THE GAME TABLE, NEVER AN AUTHORITY
// ==================================================================
//
// THE SOURCE (the LIVE-5/6 architecture preflight): §2.1 row 12 maps PROCESS mode's `ops/status.json` to "CloudWatch
// Logs + EMF; `TASK#` status items"; §3.2 specifies the item -- `TASK#<task_id>` / `TASK`, "Status and diagnostics (not
// used for correctness)", < 4 KB, written by each task every 30 s, TTL "last seen + 1 d"; §14.2 names its content (pool,
// build, status, last self-check); §13 has the task register it and set its status to ready; §17.2 step 1 has the
// operator confirm, before a restore, "that no ECS task of any pool is running and that no `TASK#` heartbeat is fresh".
// So the preflight asks for a DURABLE DynamoDB item, not only a log convention -- and it asks for a DIAGNOSTIC one. This
// module is its write model and nothing more.
//
//   pk  TASK#<task>     sk  TASK
//   fmt 1 · task · pool · pool_epoch · generation · environment · build · role (undecided | primary | non-primary) · phase (starting |
//   serving | stopping) · ready (BOOL) · reasons (the readiness codes) · relayer (its state) · escrow (its state) ·
//   pool_writer_check_age_ms · started_at · updated_at (ms) · seq · ttl (epoch SECONDS = updated_at + 1 day)
//
// WHO WRITES IT: only the task it names (the key carries the task's own random id). Each write is ONE `PutItem` with
// `attribute_not_exists(pk) OR (task = :task AND seq < :seq)`: a write that arrives late never replaces a newer one.
//
// WHY IT IS NOT FENCED BY THE POOL EPOCH OR THE GENERATION, deliberately: it is not an authoritative write. Nothing in this
// server reads it (a source guard in the L6-5A tests keeps it that way), it decides nothing, and the fences that protect
// authority are untouched. It is EVIDENCE that a process is alive and what it believes, and the one place the preflight
// uses it -- the operator's "no heartbeat is fresh" before a restore -- needs a STALE-but-alive task (paused, fenced, not
// yet exited) to keep saying so. Fencing it would hide exactly the process that check exists to find. It carries the pool
// epoch and generation it believes, so a reader compares them with `POOL#<pool>` and the ledger's `APPGEN` itself.
// It is never a liveness authority: no takeover, claim, routing or readiness decision may read it (a lease by another
// name); the preflight's §5.1 "no time lease" stands.
//
// READ IT BY FRESHNESS: `updated_at` (and the TTL) say whether the task is still writing; `phase` and `ready` are what it
// last said. A task that exits at once (a loss: exit 3; a store restart: exit 4) writes nothing more, so its last item may
// still say `serving` -- stale by `updated_at`, never by its own admission. The final `stopping` write of a graceful stop
// is best effort too (the process may exit before it lands).
//
// FAILURE IS HARMLESS: best effort, one attempt (the SDK's retries are off; the next tick writes a newer item), single
// flight (a tick while a write is still out is skipped), bounded by the client's call deadline, counted, never thrown.
// The table needs nothing new but its TTL attribute (`ttl`, L6-5B / L5-8) -- no other game-table item carries one, and
// without it the items simply stay (one small item per task start). The task role already has `PutItem` on the table.

import { ConditionalCheckFailedException, PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { key, N, S, type Item } from "../game/gameTable";
import { codeList, idText, safeCode } from "./runtimeMetrics";

export const TASK_STATUS_FORMAT = 1;
export const TASK_STATUS_SK = "TASK";
/** Preflight §3.2: every 30 s. */
export const TASK_STATUS_EVERY_MS = 30_000;
/** Preflight §3.2: TTL "last seen + 1 d". */
export const TASK_STATUS_TTL_SECONDS = 86_400;

/** A task id (the pool writer's rule): 1-128 printable characters without spaces. */
const TASK_TEXT = /^[\x21-\x7e]{1,128}$/;

export const taskStatusPk = (task: string): string => `TASK#${task}`;
export const taskStatusKey = (task: string): Item => key(taskStatusPk(task), TASK_STATUS_SK);

/** What a task says about itself. */
export interface TaskStatus {
  readonly task: string;
  readonly pool: string;
  readonly poolEpoch: number;
  readonly generation: number;
  readonly environment: string;
  readonly build: string;
  /** `undecided` until the identity-writer takeover has answered primary or not. */
  readonly role: "primary" | "non-primary" | "undecided";
  readonly phase: "starting" | "serving" | "stopping";
  readonly ready: boolean;
  readonly reasons: readonly string[];
  readonly relayer: string;
  readonly escrow: string;
  readonly poolWriterCheckAgeMs: number;
  readonly startedAt: number;
}

const whole = (value: number): number => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);

/** The item for `status`, the `seq`-th write, at `now` (ms). */
export function taskStatusItem(status: TaskStatus, seq: number, now: number): Item {
  if (!TASK_TEXT.test(status.task)) throw new Error("the task id must be 1-128 printable characters without spaces");
  const updated = whole(now);
  return {
    ...taskStatusKey(status.task),
    fmt: N(TASK_STATUS_FORMAT),
    task: S(status.task),
    pool: S(idText(status.pool)),
    pool_epoch: N(whole(status.poolEpoch)),
    generation: N(whole(status.generation)),
    environment: S(idText(status.environment)),
    build: S(idText(status.build)),
    role: S(status.role === "non-primary" || status.role === "primary" ? status.role : "undecided"),
    phase: S(safeCode(status.phase)),
    ready: { BOOL: status.ready === true },
    reasons: S(codeList(status.reasons)),
    relayer: S(safeCode(status.relayer)),
    escrow: S(safeCode(status.escrow)),
    pool_writer_check_age_ms: N(whole(status.poolWriterCheckAgeMs)),
    started_at: N(whole(status.startedAt)),
    updated_at: N(updated),
    seq: N(whole(seq)),
    ttl: N(Math.floor(updated / 1000) + TASK_STATUS_TTL_SECONDS),
  };
}

export type TaskStatusWriteResult = "written" | "stale" | "failed";

/** Where the item goes (the real one is the game table; the tests pass a recorder). */
export interface TaskStatusWriter {
  write(status: TaskStatus, seq: number, now: number): Promise<TaskStatusWriteResult>;
}

/** The game-table writer (see the header): one conditional `PutItem`, never retried, never thrown. */
export function dynamoTaskStatusWriter(options: { readonly client: DynamoDBClient; readonly table: string }): TaskStatusWriter {
  return {
    async write(status, seq, now) {
      try {
        await options.client.send(
          new PutItemCommand({
            TableName: options.table,
            Item: taskStatusItem(status, seq, now),
            ConditionExpression: "attribute_not_exists(pk) OR (#task = :task AND #seq < :seq)",
            ExpressionAttributeNames: { "#task": "task", "#seq": "seq" },
            ExpressionAttributeValues: { ":task": S(status.task), ":seq": N(whole(seq)) },
          }),
          { abortSignal: deadline() },
        );
        return "written";
      } catch (error) {
        return error instanceof ConditionalCheckFailedException || (error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException" ? "stale" : "failed";
      }
    },
  };
}

export interface TaskStatusReporter {
  /** Write the status now unless a write is still out (then this tick is skipped). Never throws, never awaited by
   *  anything that decides. */
  tick(): Promise<TaskStatusWriteResult | "skipped">;
  health(): { readonly writes: number; readonly failures: number; readonly skipped: number; readonly lastWrittenAt: number | null };
}

export function taskStatusReporter(options: {
  readonly writer: TaskStatusWriter;
  readonly status: () => TaskStatus;
  readonly now: () => number;
  /** A write that failed (not a stale one): counted into the `TaskStatusWriteFailures` metric by the caller. */
  readonly onFailure?: () => void;
}): TaskStatusReporter {
  let seq = 0;
  let inFlight: Promise<TaskStatusWriteResult> | null = null;
  let writes = 0;
  let failures = 0;
  let skipped = 0;
  let lastWrittenAt: number | null = null;
  return {
    tick() {
      if (inFlight !== null) {
        skipped += 1;
        return Promise.resolve("skipped");
      }
      let status: TaskStatus;
      try {
        status = options.status();
      } catch {
        failures += 1;
        try {
          options.onFailure?.();
        } catch {
          /* never past here */
        }
        return Promise.resolve("failed");
      }
      seq += 1;
      const at = options.now();
      const attempt = (async (): Promise<TaskStatusWriteResult> => {
        let result: TaskStatusWriteResult;
        try {
          result = await options.writer.write(status, seq, at);
        } catch {
          result = "failed";
        }
        if (result === "written") {
          writes += 1;
          lastWrittenAt = at;
        } else if (result === "failed") {
          failures += 1;
          try {
            options.onFailure?.();
          } catch {
            /* never past here */
          }
        }
        return result;
      })();
      inFlight = attempt;
      return attempt.finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    },
    health: () => ({ writes, failures, skipped, lastWrittenAt }),
  };
}
