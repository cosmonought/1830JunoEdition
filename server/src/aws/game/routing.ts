// server/src/aws/game/routing.ts
//
// ==================================================================
//  LIVE-5 L5-3: `SYSTEM/ROUTING` -- WHICH POOL IS PRIMARY -- AND THE CONDITIONS A ROLE TAKEOVER CARRIES
// ==================================================================
//
// Preflight §3.2 / §4 rows 27-28 / §5.3: the game table holds one routing item,
//
//   SYSTEM / ROUTING   { fmt 1, primary_pool, routing_version, updated_at, updated_by, claim }
//
// written ONLY by the deploy pipeline or an operator (never by a serving task: a task reads it). `primary_pool` names
// the ONE pool whose current task may hold the singleton roles -- the identity writer and (L5-6) the relayer. The
// routing decides WHO MAY TAKE a role; it is never itself a fence on game writes (those are the HEAD / POOL fences,
// `gameTable.ts`), so a routing flip never refuses a game write and never needs a game released.
//
// A ROLE IS TAKEN ONLY TOGETHER WITH THESE TWO CONDITIONS, INSIDE THE SAME TransactWriteItems as the role's own epoch
// update (`roleTakeoverChecks`):
//
//     ConditionCheck SYSTEM/ROUTING: primary_pool = :P       -- this pool is the primary NOW, at the write
//     ConditionCheck POOL#<P>/POOL:  writer_epoch = :E       -- and this task is still that pool's newest task
//
// so a task that READ "I am primary, I am current" and was then overtaken -- the pipeline flipped the routing, or a newer
// task took the pool -- is refused BY DYNAMODB at the takeover itself. No check-then-write gap: what the task saw is only
// a hint for whether to try. The identity table and the game table are in one account, so the identity-writer takeover
// (`aws/identity` `takeOverIdentityWriter`, whose `checks` these are) is a single cross-table transaction.
//
// THE ROUTING'S OWN WRITE (`setPrimaryPool`) reads the routing first (strictly) and is then a compare-and-swap on EXACTLY
// the item it read -- its version AND its `claim` (create-if-absent for the first) -- stamped with a fresh `claim`, so a
// lost answer is settled by reading the item: our claim there -> set; another version -> conflict (the routing is not the
// one this call was asked to move, whoever moved it -- this call's own write included, if another change followed it);
// unchanged -> unknown, and the caller asks again with the SAME expected version (which can never move it twice). An item
// this build cannot read is refused whole -- never overwritten, never read as "no primary" by a writer and never as
// "primary" by a reader: a task that cannot read the routing takes no role.

import { randomUUID } from "crypto";
import { PutItemCommand, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { fenceProblem, getItem, key, N, poolFence, S, type Item, type WriterFence } from "./gameTable";

export const ROUTING_KEY: Item = key("SYSTEM", "ROUTING");
export const ROUTING_FORMAT = 1;

export interface RoutingRecord {
  readonly primary_pool: string;
  /** 1 for the first routing, +1 per change. */
  readonly routing_version: number;
  readonly updated_at: number;
  /** Who moved it (the pipeline run, an operator): diagnostic only. */
  readonly updated_by: string;
  /** The token of the write that set this version (how a lost answer is settled). */
  readonly claim: string;
}

export class RoutingUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingUnreadableError";
  }
}

const TEXT = /^[\x21-\x7e]{1,128}$/;

/** Why `pool` cannot be the primary (`null`: it can). A pool id (as every writer fence), and never an operator run. */
export function primaryPoolProblem(pool: string): string | null {
  const problem = fenceProblem({ pool, epoch: 1 });
  if (problem !== null) return problem;
  if (pool.startsWith("op:")) return `an operator run (${pool}) is never the primary pool`;
  return null;
}

const integer = (item: Item, name: string, min: number): number | null => {
  const text = item[name]?.N;
  if (text === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min ? value : null;
};

/** The routing item, strictly: every field present and well-formed, nothing else, this build's format. */
export function parseRouting(item: Item): RoutingRecord {
  const names = Object.keys(item).sort().join(",");
  if (names !== "claim,fmt,pk,primary_pool,routing_version,sk,updated_at,updated_by") throw new RoutingUnreadableError(`the routing item has the attributes [${names}], not this build's`);
  if (item.pk?.S !== "SYSTEM" || item.sk?.S !== "ROUTING") throw new RoutingUnreadableError("the routing item is not SYSTEM/ROUTING");
  const fmt = integer(item, "fmt", 1);
  if (fmt !== ROUTING_FORMAT) throw new RoutingUnreadableError(`the routing item's format is ${item.fmt?.N ?? "missing"}, not ${ROUTING_FORMAT}`);
  const primary = item.primary_pool?.S;
  if (primary === undefined || primaryPoolProblem(primary) !== null) throw new RoutingUnreadableError(`the routing item's primary pool ${JSON.stringify(primary)} is not a pool id`);
  const version = integer(item, "routing_version", 1);
  const at = integer(item, "updated_at", 0);
  if (version === null || at === null) throw new RoutingUnreadableError("the routing item's version or time is not a whole number");
  const by = item.updated_by?.S;
  const claim = item.claim?.S;
  if (by === undefined || !TEXT.test(by) || claim === undefined || !TEXT.test(claim)) throw new RoutingUnreadableError("the routing item's author or claim is not well-formed");
  return { primary_pool: primary, routing_version: version, updated_at: at, updated_by: by, claim };
}

/** The routing as it stands (strongly consistent), `null` when no routing was ever written. Throws
 *  `RoutingUnreadableError` for an item this build cannot read. */
export async function readRouting(client: DynamoDBClient, table: string): Promise<RoutingRecord | null> {
  const item = await getItem(client, table, ROUTING_KEY);
  return item === null ? null : parseRouting(item);
}

export type SetPrimaryOutcome =
  | { readonly kind: "set"; readonly routing: RoutingRecord }
  /** The routing is not at `expectedVersion` (another change landed first): nothing of this call was written. */
  | { readonly kind: "conflict"; readonly current: RoutingRecord | null };

/**
 * The pipeline's (or an operator's) change of the primary pool: compare-and-swap on the version it read (`null`: the
 * routing must not exist yet). Never called by a serving task. Throws when the outcome is unknown (ask again with the
 * same expected version: it can never move the routing twice) and for an item this build cannot read.
 */
export async function setPrimaryPool(
  client: DynamoDBClient,
  table: string,
  change: { readonly pool: string; readonly expectedVersion: number | null; readonly by: string; readonly now: number },
): Promise<SetPrimaryOutcome> {
  const problem = primaryPoolProblem(change.pool);
  if (problem !== null) throw new Error(`setPrimaryPool: ${problem} (nothing was sent)`);
  if (!TEXT.test(change.by)) throw new Error("setPrimaryPool: `by` must be 1-128 printable characters without spaces (nothing was sent)");
  if (!Number.isSafeInteger(change.now) || change.now < 0) throw new Error("setPrimaryPool: the time is not whole milliseconds (nothing was sent)");
  if (change.expectedVersion !== null && !(Number.isSafeInteger(change.expectedVersion) && change.expectedVersion >= 1)) throw new Error("setPrimaryPool: the expected version is not a positive integer (nothing was sent)");
  const version = (change.expectedVersion ?? 0) + 1;
  /* The item this call replaces, read strictly first (an unreadable one throws here: never overwritten). */
  const before = await readRouting(client, table);
  if ((before === null ? null : before.routing_version) !== change.expectedVersion) return { kind: "conflict", current: before };
  const claim = randomUUID();
  const item: Item = {
    ...ROUTING_KEY,
    fmt: N(ROUTING_FORMAT),
    primary_pool: S(change.pool),
    routing_version: N(version),
    updated_at: N(change.now),
    updated_by: S(change.by),
    claim: S(claim),
  };
  let failure: unknown = null;
  try {
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: item,
        ConditionExpression: before === null ? "attribute_not_exists(pk)" : "#fmt = :fmt AND #v = :expected AND #claim = :read",
        ...(before === null
          ? {}
          : {
              ExpressionAttributeNames: { "#fmt": "fmt", "#v": "routing_version", "#claim": "claim" },
              ExpressionAttributeValues: { ":fmt": N(ROUTING_FORMAT), ":expected": N(before.routing_version), ":read": S(before.claim) },
            }),
      }),
      { abortSignal: deadline() },
    );
    return { kind: "set", routing: parseRouting(item) };
  } catch (error) {
    failure = error;
  }
  /* Refused by its condition, or unknown: the item as it stands decides -- never the error alone. */
  const current = await readRouting(client, table);
  if (current !== null && current.claim === claim) return { kind: "set", routing: current };
  const moved = current === null ? change.expectedVersion !== null : current.routing_version !== change.expectedVersion;
  if (moved || (failure as { name?: string } | null)?.name === "ConditionalCheckFailedException") return { kind: "conflict", current };
  throw new Error(`setPrimaryPool: the routing did not move and the outcome is not known (${failure instanceof Error ? failure.message : String(failure)}); ask again with the same expected version`);
}

/** `ConditionCheck SYSTEM/ROUTING primary_pool = :P` -- inside the write that takes a role. */
export function routingCheck(table: string, pool: string): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: ROUTING_KEY,
      ConditionExpression: "#fmt = :fmt AND #pp = :P",
      ExpressionAttributeNames: { "#fmt": "fmt", "#pp": "primary_pool" },
      ExpressionAttributeValues: { ":fmt": N(ROUTING_FORMAT), ":P": S(pool) },
    },
  };
}

/** The two conditions every role takeover carries (preflight §4 rows 27-28), in this order: the routing names this pool
 *  primary, and this task's epoch is still the pool's newest. Pass them as `checks` to the role's takeover. */
export function roleTakeoverChecks(table: string, fence: WriterFence): TransactWriteItem[] {
  const problem = fenceProblem(fence);
  if (problem !== null) throw new Error(`roleTakeoverChecks: ${problem}`);
  const primary = primaryPoolProblem(fence.pool);
  if (primary !== null) throw new Error(`roleTakeoverChecks: ${primary}`);
  return [routingCheck(table, fence.pool), poolFence(table, fence)];
}
