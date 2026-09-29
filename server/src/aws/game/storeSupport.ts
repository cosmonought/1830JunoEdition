// server/src/aws/game/storeSupport.ts
//
// LIVE-5 L5-2: what every game-table adapter shares -- its construction options, and the one rule for turning a
// `transactWrite` answer into a port outcome when the first attempt's answer was lost.
//
// THE SETTLING RULE (preflight §4, "a conditional failure returned to a resend is settled by a strong read"). After an
// unknown outcome the adapter reads the item(s) the write would have made, strongly, and looks for THIS write's
// attempt token (`att` / `atts`, stamped by every write):
//
//   the token is there                      -> committed (redone): the write happened, exactly once.
//   the token is not there, and DynamoDB EVALUATED a resend and refused it
//                                            -> the write never happened (an applied original would have made the
//                                               identical resend answer success): the port's definite answer, from
//                                               the resend's own cancellation reasons (fenced, or the CAS term).
//   the token is not there, and no resend was ever evaluated (the window ended on timeouts), or the read failed
//                                            -> UNCERTAIN: the write may still land later. "Nothing was written" is
//                                               never concluded from an absence alone.
//
// THE READ PATTERN (the L5-5 handoff): a fence is read on its own (a single strongly consistent GetItem -- never inside
// a transactional read, where a shared fence item would conflict with every writer); the write's TARGET SET is then read
// as ONE snapshot -- a single item's strongly consistent GetItem, or TransactGetItems for several (a plain read of
// several items can see a transaction half-applied) -- and that snapshot alone decides "this write's token is there".

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { fenceProblem, type WriterFence } from "./gameTable";
import { resendTiming, type ResendTiming, type WriteAnswer } from "./transact";

export interface GameTableStoreOptions {
  /** From `aws/awsClients.ts` (`createDynamoDbClient`), never made here. */
  readonly client: DynamoDBClient;
  readonly table: string;
  /** The writer: this task's pool and the pool epoch it took (L5-3). Carried into the condition of every write. */
  readonly fence: WriterFence;
  /** Resend timing (tests shorten the window and make the sleep immediate). */
  readonly timing?: Partial<ResendTiming>;
  /** Query page size (tests make it small, to exercise paging). */
  readonly pageSize?: number;
}

export interface Resolved {
  readonly client: DynamoDBClient;
  readonly table: string;
  readonly fence: WriterFence;
  readonly timing: ResendTiming;
  readonly pageSize: number | undefined;
}

export function resolveOptions(options: GameTableStoreOptions, what: string): Resolved {
  const problem = fenceProblem(options.fence);
  if (problem !== null) throw new Error(`${what}: ${problem}`);
  if (typeof options.table !== "string" || options.table.length < 3) throw new Error(`${what}: a table name is required`);
  return { client: options.client, table: options.table, fence: { pool: options.fence.pool, epoch: options.fence.epoch }, timing: resendTiming(options.timing), pageSize: options.pageSize };
}

export const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Whether a `transactWrite` answer still needs the strong read (the original's answer was lost). */
export const needsSettling = (answer: WriteAnswer): boolean => answer.kind === "unknown" || (answer.kind === "refused" && answer.resend);

/** An answer that is neither applied nor refused unapplied: evaluated and refused, or unknown. */
export type EvaluatedOrUnknown = Extract<WriteAnswer, { kind: "unknown" | "refused" }>;

/** A reason code at an action index is a failed condition. */
export const conditionFailed = (answer: WriteAnswer, at: number): boolean => answer.kind === "refused" && answer.reasons[at]?.code === "ConditionalCheckFailed";

export const FENCED = "fenced: this writer's epoch no longer owns the game (a newer writer took it over); nothing was written";
export const POOL_FENCED = "fenced: this writer's pool epoch is no longer the pool's newest (a newer task took the pool over); nothing was written";
