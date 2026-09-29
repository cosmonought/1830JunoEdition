// server/src/aws/game/ownership.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE OWNERSHIP PRIMITIVES -- TAKE A POOL, CLAIM A GAME, RELEASE A GAME (L5-3 DRIVES THEM)
// ==================================================================
//
// Preflight D-4 / §5: no lease and no clock. The newest task of a pool takes the pool (`POOL#<P>` `writer_epoch` + 1);
// it then CLAIMS each game it serves by stamping the game's HEAD with (pool, epoch), and from then on every write of an
// older task of the pool to that game fails its fence INSIDE the write. These are the storage primitives only: when to
// take, claim, route or release is L5-3's PoolWriter (not built here).
//
//   takeOverPool   `writer_epoch` + 1, conditional on the epoch read, so a lost answer is settled by a strong read (this
//                  task's name at the new epoch) and never becomes two epochs for one task.
//   claimGame      ONE transaction: [the POOL fence -- the claimer's epoch is still its pool's newest; Update HEAD COND the
//                  game exists AND (it is this pool's at this or an older epoch, OR it is released)]. A stale task of a
//                  pool can therefore claim nothing (not even a released game), an epoch the pool never reached cannot be
//                  claimed with, and a claim never makes a game. Idempotent: a resend of a landed claim is admitted by the
//                  same condition. The claimed HEAD is then read strongly (a transaction returns no values).
//   releaseGame    `owner_pool` := none, only by the writer that owns it.

import { UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { fenceProblem, getItem, headKey, headOf, N, NO_OWNER, numberOf, poolFence, poolKey, S, type HeadRead, type WriterFence } from "./gameTable";
import { resendTiming, transactWrite, type ResendTiming } from "./transact";

export interface PoolRead {
  readonly writer_epoch: number;
  readonly writer_task: string | null;
}

export async function readPool(client: DynamoDBClient, table: string, pool: string): Promise<PoolRead | null> {
  const item = await getItem(client, table, poolKey(pool));
  if (item === null) return null;
  return { writer_epoch: numberOf(item.writer_epoch) ?? 0, writer_task: item.writer_task?.S ?? null };
}

const errorName = (error: unknown): string => (error as { name?: string } | null)?.name ?? "";
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Take pool `pool` for task `task` (see the header). Answers the new epoch, or `lost` when another task of the pool
 *  took it in between (the caller reads again and decides). */
export async function takeOverPool(client: DynamoDBClient, table: string, pool: string, task: string, now: number): Promise<{ readonly kind: "taken"; readonly epoch: number } | { readonly kind: "lost"; readonly by: PoolRead }> {
  if (fenceProblem({ pool, epoch: 1 }) !== null) throw new Error(`takeOverPool: ${JSON.stringify(pool)} is not a pool id`);
  const before = await readPool(client, table, pool);
  const previous = before?.writer_epoch ?? 0;
  const next = previous + 1;
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: table,
        Key: poolKey(pool),
        UpdateExpression: "SET #we = :next, #wt = :task, #at = :now",
        ConditionExpression: previous === 0 ? "attribute_not_exists(#we)" : "#we = :previous",
        ExpressionAttributeNames: { "#we": "writer_epoch", "#wt": "writer_task", "#at": "taken_at" },
        ExpressionAttributeValues: { ":next": N(next), ":task": S(task), ":now": N(now), ...(previous === 0 ? {} : { ":previous": N(previous) }) },
      }),
      { abortSignal: deadline() },
    );
    return { kind: "taken", epoch: next };
  } catch (error) {
    /* Refused by its condition, unknown, or refused unapplied: what the table holds now decides. */
    const after = await readPool(client, table, pool);
    if (after !== null && after.writer_epoch === next && after.writer_task === task) return { kind: "taken", epoch: next };
    if (after !== null && after.writer_epoch !== previous) return { kind: "lost", by: after };
    if (errorName(error) === "ConditionalCheckFailedException") return { kind: "lost", by: after ?? { writer_epoch: 0, writer_task: null } };
    throw new Error(`takeOverPool: the pool's epoch did not move and the outcome is not known (${describe(error)})`);
  }
}

export type ClaimOutcome =
  | { readonly kind: "claimed"; readonly head: HeadRead }
  /** Another pool owns it, or a NEWER task of this pool does. */
  | { readonly kind: "owned-elsewhere"; readonly head: HeadRead }
  /** The claimer's epoch is not its pool's newest (it is stale, or the epoch was never taken): it may claim nothing. */
  | { readonly kind: "stale-pool" }
  | { readonly kind: "absent" };

/** Claim an EXISTING game for (pool, epoch) (see the header). */
export async function claimGame(client: DynamoDBClient, table: string, gameId: string, fence: WriterFence & { readonly task: string }, timing: Partial<ResendTiming> = {}): Promise<ClaimOutcome> {
  const problem = fenceProblem(fence);
  if (problem !== null) throw new Error(`claimGame: ${problem}`);
  const answer = await transactWrite(
    client,
    [
      poolFence(table, fence),
      {
        Update: {
          TableName: table,
          Key: headKey(gameId),
          UpdateExpression: "SET #op = :P, #pe = :E, #ot = :T",
          ConditionExpression: "attribute_exists(pk) AND ((#op = :P AND #pe <= :E) OR #op = :none)",
          ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch", "#ot": "owner_task" },
          ExpressionAttributeValues: { ":P": S(fence.pool), ":E": N(fence.epoch), ":T": S(fence.task), ":none": S(NO_OWNER) },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        },
      },
    ],
    resendTiming(timing),
  );
  if (answer.kind === "not-applied") throw new Error(`claimGame: the claim was refused unapplied (${answer.detail}); claim again`);
  /* The pool fence refused it: this claimer is stale (or its epoch was never taken), whatever the HEAD still says --
     the caller must learn that, not "claimed" from a HEAD an older claim of its own left behind (review round 2). */
  if (answer.kind === "refused" && answer.reasons[0]?.code === "ConditionalCheckFailed") return { kind: "stale-pool" };
  const head = headOf(await getItem(client, table, headKey(gameId)));
  /* Applied, or a lost answer whose resend was refused or never evaluated: the HEAD as it stands decides. The claim is
     idempotent, so "it names this writer now" is exactly "claimed". */
  if (head !== null && head.owner_pool === fence.pool && head.pool_epoch === fence.epoch) return { kind: "claimed", head };
  if (answer.kind === "applied") throw new Error("claimGame: the claim was applied but the HEAD does not name this writer (the table changed in between)");
  if (answer.kind === "unknown") throw new Error(`claimGame: the claim's outcome is unknown (${answer.detail}); claim again`);
  if (head === null) return { kind: "absent" };
  return { kind: "owned-elsewhere", head };
}

/** Release a game this writer owns (`owner_pool` := none). Answers false when it is not this writer's (nothing to do). */
export async function releaseGame(client: DynamoDBClient, table: string, gameId: string, fence: WriterFence): Promise<boolean> {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: table,
        Key: headKey(gameId),
        UpdateExpression: "SET #op = :none",
        ConditionExpression: "#op = :P AND #pe = :E",
        ExpressionAttributeNames: { "#op": "owner_pool", "#pe": "pool_epoch" },
        ExpressionAttributeValues: { ":P": S(fence.pool), ":E": N(fence.epoch), ":none": S(NO_OWNER) },
      }),
      { abortSignal: deadline() },
    );
    return true;
  } catch (error) {
    if (errorName(error) !== "ConditionalCheckFailedException") {
      /* Unknown: the HEAD decides (released by this call, or still this writer's -- then release again). */
      const head = headOf(await getItem(client, table, headKey(gameId)));
      if (head?.owner_pool === NO_OWNER) return true;
      throw new Error(`releaseGame: the release's outcome is unknown (${describe(error)}); release again`);
    }
    return false;
  }
}
