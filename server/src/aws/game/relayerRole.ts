// server/src/aws/game/relayerRole.ts
//
// ==================================================================
//  LIVE-5 L5-6: `ROLE#relayer#<account>` -- THE GAME TABLE'S MIRROR OF THE LEDGER'S RELAYER FENCE, AND ITS CONDITION
// ==================================================================
//
// Preflight §3.2 / §4 rows 16, 17 and 28 / §12.2. The relayer is ONE task: the current task of the primary pool. Its
// epoch is minted in the LEDGER (`FENCE#relayer#<account>`, L5-5's `takeOverRelayer`: the ledger is never restored with
// the app, so the epoch never goes backwards) and then MIRRORED here, in the game table, where the relayer's own
// application writes -- the chain intents -- can carry it inside their transactions:
//
//   ROLE#relayer#<account> / ROLE   { fmt 1, epoch r, task, pool, pool_epoch, taken_at, claim }
//
//   epoch       the ledger fence epoch this mirror names (r: minted by `takeOverRelayer`, never chosen here)
//   task, pool, pool_epoch
//               who took it: the primary pool's task at its pool epoch (diagnostic; the conditions below decided it)
//   claim       the token of the transaction that wrote this mirror -- how a lost answer is settled, and what the
//               relayer's intent writes are conditioned on (a new mirror always carries a new claim)
//
// THE MIRROR'S WRITE (`mirrorRelayerRole`) is ONE TransactWriteItems in the game table:
//
//     [ConditionCheck SYSTEM/ROUTING primary_pool = :P;        (L5-3 `roleTakeoverChecks`: this pool is primary NOW)
//      ConditionCheck POOL#P writer_epoch = :E;                (and this task is still its pool's newest task)
//      Put ROLE#relayer#<account> COND attribute_not_exists(pk) OR (fmt = 1 AND epoch < :r)]
//
// so a task that READ "I am primary, I am current" and was then overtaken -- a routing flip, a newer task of the pool --
// is refused BY DYNAMODB at the mirror itself, and the mirror only ever moves FORWARD, to a newer ledger epoch: a late
// copy of an older mirror (an answer lost, then a later mint and mirror) can never land over a newer one, and a game
// table restored with an older mirror is simply overwritten by the next takeover's newer epoch. An item this build cannot
// read is never overwritten (its `fmt` fails the condition) and is refused whole by every read.
//
// ROLE_RL (`relayerRoleFence`): `ConditionCheck ROLE#relayer#<account>: fmt = 1 AND epoch = :r AND claim = :claim` --
// carried INSIDE every intent write the relayer makes (`dynamoIntentStore` with `relayerRole`, preflight §4 rows 16-17),
// instead of the game's HEAD fence: the relayer writes intents of games it may not own, and a relayer whose mirror was
// replaced (a newer primary took the role) writes nothing more there, however long it paused after its own checks.

import { randomUUID } from "crypto";
import type { DynamoDBClient, TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { getItem, key, N, S, type Item } from "./gameTable";
import { resendTiming, transactWrite, type ResendTiming } from "./transact";

export const RELAYER_ROLE_FORMAT = 1;

/** The relayer account as the ledger spells it (lower-case bech32: letters and digits only, so it never breaks a key). */
const ACCOUNT = /^[a-z][a-z0-9]{2,89}$/;
const TEXT = /^[\x21-\x7e]{1,128}$/;

export const relayerRoleKey = (account: string): Item => key(`ROLE#relayer#${account}`, "ROLE");

export interface RelayerRoleRecord {
  readonly account: string;
  /** The ledger's relayer fence epoch this mirror names. */
  readonly epoch: number;
  readonly task: string;
  readonly pool: string;
  readonly pool_epoch: number;
  readonly taken_at: number;
  /** The token of the transaction that wrote this mirror. */
  readonly claim: string;
}

/** What a mirror names, for the condition every relayer intent write carries. */
export interface RelayerRoleHeld {
  readonly epoch: number;
  readonly claim: string;
}

export class RelayerRoleUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayerRoleUnreadableError";
  }
}

export function relayerAccountProblem(account: unknown): string | null {
  return typeof account === "string" && ACCOUNT.test(account) ? null : `${JSON.stringify(account)} is not a relayer account`;
}

const integer = (item: Item, name: string, min: number): number | null => {
  const text = item[name]?.N;
  if (text === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min ? value : null;
};

/** The mirror, strictly: every field present and well-formed, nothing else, this build's format, its key its account. */
export function parseRelayerRole(item: Item, account: string): RelayerRoleRecord {
  const names = Object.keys(item).sort().join(",");
  if (names !== "claim,epoch,fmt,pk,pool,pool_epoch,sk,taken_at,task") throw new RelayerRoleUnreadableError(`the relayer role item has the attributes [${names}], not this build's`);
  const expected = relayerRoleKey(account);
  if (item.pk?.S !== expected.pk.S || item.sk?.S !== expected.sk.S) throw new RelayerRoleUnreadableError(`the relayer role item is not ${expected.pk.S}/ROLE`);
  if (integer(item, "fmt", 1) !== RELAYER_ROLE_FORMAT) throw new RelayerRoleUnreadableError(`the relayer role item's format is ${item.fmt?.N ?? "missing"}, not ${RELAYER_ROLE_FORMAT}`);
  const epoch = integer(item, "epoch", 1);
  const poolEpoch = integer(item, "pool_epoch", 1);
  const takenAt = integer(item, "taken_at", 0);
  if (epoch === null || poolEpoch === null || takenAt === null) throw new RelayerRoleUnreadableError("the relayer role item's epochs or time are not whole numbers");
  const task = item.task?.S;
  const pool = item.pool?.S;
  const claim = item.claim?.S;
  if (task === undefined || !TEXT.test(task) || pool === undefined || !TEXT.test(pool) || claim === undefined || !TEXT.test(claim)) throw new RelayerRoleUnreadableError("the relayer role item's task, pool or claim is not well-formed");
  return { account, epoch, task, pool, pool_epoch: poolEpoch, taken_at: takenAt, claim };
}

/** The mirror as it stands (strongly consistent), `null` when none was ever written. Throws `RelayerRoleUnreadableError`
 *  for an item this build cannot read (never read as "no relayer", never as "this task's"). */
export async function readRelayerRole(client: DynamoDBClient, table: string, account: string): Promise<RelayerRoleRecord | null> {
  const problem = relayerAccountProblem(account);
  if (problem !== null) throw new Error(`readRelayerRole: ${problem}`);
  const item = await getItem(client, table, relayerRoleKey(account));
  return item === null ? null : parseRelayerRole(item, account);
}

/** ROLE_RL: the mirror still names exactly this holder -- INSIDE the write that carries it (preflight §4 rows 16-17). */
export function relayerRoleFence(table: string, account: string, held: RelayerRoleHeld): TransactWriteItem {
  const problem = relayerAccountProblem(account);
  if (problem !== null) throw new Error(`relayerRoleFence: ${problem}`);
  if (!Number.isSafeInteger(held.epoch) || held.epoch < 1 || typeof held.claim !== "string" || !TEXT.test(held.claim)) throw new Error("relayerRoleFence: a held relayer role names its epoch and its claim");
  return {
    ConditionCheck: {
      TableName: table,
      Key: relayerRoleKey(account),
      ConditionExpression: "#fmt = :fmt AND #epoch = :r AND #claim = :claim",
      ExpressionAttributeNames: { "#fmt": "fmt", "#epoch": "epoch", "#claim": "claim" },
      ExpressionAttributeValues: { ":fmt": N(RELAYER_ROLE_FORMAT), ":r": N(held.epoch), ":claim": S(held.claim) },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    },
  };
}

export type MirrorOutcome =
  | { readonly kind: "mirrored"; readonly role: RelayerRoleRecord }
  /** Evaluated and refused: `which` names the first condition that failed (the routing, this task's pool epoch, or a
   *  mirror already at this epoch or newer). Nothing was written. */
  | { readonly kind: "refused"; readonly which: "routing" | "pool" | "role" | "other"; readonly detail: string; readonly claim: string }
  /** No evaluated answer: the mirror MAY STILL LAND later (it can then never pass a newer mirror). */
  | { readonly kind: "unknown"; readonly detail: string; readonly claim: string };

/**
 * Write the mirror of ledger epoch `epoch` for `account` (see the header), with `checks` -- L5-3's `roleTakeoverChecks`
 * -- inside the same transaction, in front of the Put. One logical write: one token, resent unchanged (L5-2's engine).
 * A lost answer is settled here by the mirror's `claim`; the caller explains a refusal from the table.
 */
export async function mirrorRelayerRole(
  client: DynamoDBClient,
  table: string,
  mirror: {
    readonly account: string;
    readonly epoch: number;
    readonly task: string;
    readonly pool: string;
    readonly poolEpoch: number;
    readonly now: number;
    readonly checks: readonly TransactWriteItem[];
    readonly timing?: Partial<ResendTiming>;
  },
): Promise<MirrorOutcome> {
  const problem = relayerAccountProblem(mirror.account);
  if (problem !== null) throw new Error(`mirrorRelayerRole: ${problem} (nothing was sent)`);
  if (!Number.isSafeInteger(mirror.epoch) || mirror.epoch < 1) throw new Error("mirrorRelayerRole: the ledger epoch is not a positive integer (nothing was sent)");
  if (!Number.isSafeInteger(mirror.poolEpoch) || mirror.poolEpoch < 1) throw new Error("mirrorRelayerRole: the pool epoch is not a positive integer (nothing was sent)");
  if (!TEXT.test(mirror.task) || !TEXT.test(mirror.pool)) throw new Error("mirrorRelayerRole: the task and pool must each be 1-128 printable characters without spaces (nothing was sent)");
  if (!Number.isSafeInteger(mirror.now) || mirror.now < 0) throw new Error("mirrorRelayerRole: the time is not whole milliseconds (nothing was sent)");
  /* The claim is the transaction's own request token: a resend of the identical request carries the same one. */
  const timing = resendTiming(mirror.timing);
  const claim = randomUUID();
  const item: Item = {
    ...relayerRoleKey(mirror.account),
    fmt: N(RELAYER_ROLE_FORMAT),
    epoch: N(mirror.epoch),
    task: S(mirror.task),
    pool: S(mirror.pool),
    pool_epoch: N(mirror.poolEpoch),
    taken_at: N(mirror.now),
    claim: S(claim),
  };
  const items: TransactWriteItem[] = [
    ...mirror.checks,
    {
      Put: {
        TableName: table,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk) OR (#fmt = :fmt AND #epoch < :r)",
        ExpressionAttributeNames: { "#fmt": "fmt", "#epoch": "epoch" },
        ExpressionAttributeValues: { ":fmt": N(RELAYER_ROLE_FORMAT), ":r": N(mirror.epoch) },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      },
    },
  ];
  const answer = await transactWrite(client, items, { ...timing, token: () => claim });
  if (answer.kind === "applied") return { kind: "mirrored", role: parseRelayerRole(item, mirror.account) };
  if (answer.kind === "not-applied") return { kind: "refused", which: "other", detail: `${answer.detail}; nothing was written`, claim };
  /* Evaluated on its FIRST attempt: the reasons say which term failed. A resend refused, or no evaluated answer at all:
     the mirror itself decides (our claim there -> it landed, exactly once). */
  if (answer.kind === "refused" && !answer.resend) {
    const failed = answer.reasons.findIndex((reason) => reason.code === "ConditionalCheckFailed");
    const checks = mirror.checks.length;
    const which = failed < 0 ? "other" : failed === checks ? "role" : failed === 0 && checks >= 1 ? "routing" : failed === 1 && checks >= 2 ? "pool" : "other";
    return { kind: "refused", which, detail: answer.detail, claim };
  }
  let stored: RelayerRoleRecord | null;
  try {
    stored = await readRelayerRole(client, table, mirror.account);
  } catch (error) {
    return { kind: "unknown", detail: `${answer.detail}; the settling read failed (${error instanceof Error ? error.message : String(error)})`, claim };
  }
  if (stored !== null && stored.claim === claim) return { kind: "mirrored", role: stored };
  if (answer.kind === "refused") return { kind: "refused", which: "other", detail: `${answer.detail} (a resend after an unknown outcome was evaluated and refused; the mirror is not this write's)`, claim };
  return { kind: "unknown", detail: `${answer.detail}; the mirror is not visible and it may still land`, claim };
}
