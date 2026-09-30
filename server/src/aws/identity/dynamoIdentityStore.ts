// server/src/aws/identity/dynamoIdentityStore.ts
//
// ==================================================================
//  LIVE-5 L5-4: THE DYNAMODB IDENTITY STORE (preflight §3.3, §4 rows 19-24 and 27, §7.1)
// ==================================================================
//
// The identity port (`IdentityStore`: `load` everything, `commit` one change under its preconditions) over one DynamoDB
// table, for the IDENTITY WRITER -- the one task that holds the identity-writer role (`ROLE#identity-writer`, whose
// `epoch` is ROLE_ID). Plus the durable sensitive-auth grants (`grants`, identity/grants.ts) in the same table, under the
// same fence. It is constructed with the role epoch it holds; it never takes the role itself (`takeOverIdentityWriter`
// does, and the caller then loads -- so no identity write it cannot see can follow its load, preflight §7.2).
//
// EVERY WRITE IS ONE `TransactWriteItems` (preflight D-3) whose first two actions are always
//   [0] ROLE_ID: ConditionCheck ROLE#identity-writer `epoch = :mine` -- the fence, INSIDE the write: a writer whose
//       role was taken over is refused by DynamoDB itself, however late its request arrives (conformance ID-14);
//   [1] the COMMIT MARKER: Put TXN#<token> if absent -- written by this transaction and only by it,
// then the change's own actions, every precondition a condition of the item it names (`identityPlan.ts`).
//
// OUTCOMES -- the port's contract, exactly:
//   committed   the service applies the change.
//   DEFINITE    nothing was written: a failed precondition (the writer's own pre-check, or DynamoDB's), the fence
//               (`fenced`: this writer is stale -- `onFenced`, and every later write is refused at once), or a service
//               rejection that evaluated nothing (throttling, a conflict, validation). A logical refusal is never
//               reported as anything else, and nothing else is ever reported as a logical refusal.
//   UNKNOWN     a timeout, a network error, a 5xx: the request may have been applied. It is resent IDENTICALLY -- the
//               same ClientRequestToken (DynamoDB answers a resend of an applied request with its success, inside the
//               token's 10-minute window) -- and a resend that comes back refused by a condition is settled by a STRONG
//               READ OF THE MARKER, never taken at face value: the marker is there -> committed (ours landed); it is
//               not, and the resend was evaluated -> definite (a transaction evaluated with our token cannot land
//               later, and nothing else can write the marker). Still unknown after the resends: StoreUncertainError,
//               the store HOLDS ITSELF (every later commit refused) and asks for a restart (`onRestartRequired`) --
//               whose takeover moves the fence, so any straggler of this writer can never land after it.
//
// THE WRITER'S INDEX. As the journal store does, the adapter keeps the loaded set as an `IdentityIndex` and checks each
// change against it first (the same verdict and message as the memory and journal stores: a change they refuse, this
// refuses, before anything is sent). The conditions are the AUTHORITY -- they hold the same rules atomically in the
// write. If they ever disagree (the table was changed behind this writer's back), the change is refused DEFINITE and the
// store holds itself for a restart: a writer whose memory is not the table must not keep answering from it.
//
// ONE CHANGE, SEVERAL TRANSACTIONS (a change over 98 items): the chunks are sent in the planner's safe order. Once the
// first has committed, a later one that fails is a change applied IN PART: reported UNKNOWN (never definite -- something
// was written), and the store holds itself for a restart, which loads the prefix the table really holds (a valid, safe
// identity set by the planner's ordering: every security effect -- a disable, a key rotation, the revoked families, the
// link codes, the sessions ended one by one -- first; review F1). A later chunk refused without being evaluated
// (throttled) is retried for about 15 s first (review F7), and so is the first once the caller's step has run
// (re-review N1).
//
// THE CALLER'S STEP BEFORE THE WRITE (`IdentityCommitOptions.beforeWrite`, review F2): after the pre-check and the plan,
// the store reads its role strongly -- a writer that was taken over learns it there, and nothing of the caller's runs --
// then runs the step (the identity service's security event), then writes. A takeover after that read is still refused
// inside the write.
//
// A LOAD checks the role too (review F6): a writer whose epoch is not the table's is fenced at once (`onFenced`), so it
// does not serve from memory what another writer may be changing. GRANTS are best effort and hold the writer's queue
// while they run: one resend, each call bounded to 2 s (review F4).

import { randomUUID } from "crypto";
import { GetItemCommand, ScanCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem, type TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { canonicalGrant, isSensitiveAuthGrant, type SensitiveAuthGrant, type SensitiveAuthGrantStore } from "../../identity/grants";
import { SESSION_ID_PATTERN } from "../../identity/ids";
import {
  applyChange,
  changeShapeProblem,
  checkSnapshot,
  IdentityIndex,
  IdentityStoreCorruptError,
  preconditionFailure,
  type FullIdentitySnapshot,
  type IdentityChange,
  type IdentityCommitOptions,
  type IdentityStore,
  type LinkCredential,
  type Principal,
  type Profile,
  type Session,
  type SessionFamily,
} from "../../identity/store";
import { StoreDefiniteError, StoreUncertainError } from "../../persistence/storeResult";
import { decodeItem, grantItem, isRoleText, keyAttributes, keys, markerItem, RESTORE_KEY, ROLE_KEY, type Item, type RestoreRecord, type ReviewRecord, type RoleRecord, type SelectorRecord } from "./identityItems";
import { CHUNK_BUDGET, planIdentityChange, type PlannedAction } from "./identityPlan";

/* ------------------------------------------------------------------ */
/* Sending one transaction, and settling an unknown outcome            */
/* ------------------------------------------------------------------ */

/** Service answers that mean "refused: nothing was evaluated or applied". Everything else unrecognised is UNKNOWN. */
export const DEFINITE_SERVICE_ERRORS: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ValidationException",
  "ResourceNotFoundException",
  "TransactionConflictException",
  "IdempotentParameterMismatchException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "ConditionalCheckFailedException",
]);

export type SendAnswer =
  | { readonly kind: "ok" }
  | { readonly kind: "canceled"; readonly codes: readonly string[]; readonly detail: string }
  | { readonly kind: "in-progress"; readonly detail: string }
  | { readonly kind: "refused"; readonly detail: string }
  | { readonly kind: "unknown"; readonly detail: string };

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** One TransactWriteItems, classified. Never throws. `deadlineMs` bounds the call (default: the L5-1 call deadline). */
export async function sendTransaction(client: DynamoDBClient, input: TransactWriteItemsCommandInput, deadlineMs?: number): Promise<SendAnswer> {
  try {
    await client.send(new TransactWriteItemsCommand(input), { abortSignal: deadline(deadlineMs) });
    return { kind: "ok" };
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name === "TransactionCanceledException") {
      const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
      return { kind: "canceled", codes: reasons.map((reason) => reason.Code ?? "None"), detail: describe(error) };
    }
    if (name === "TransactionInProgressException") return { kind: "in-progress", detail: describe(error) };
    if (DEFINITE_SERVICE_ERRORS.has(name)) return { kind: "refused", detail: describe(error) };
    return { kind: "unknown", detail: describe(error) };
  }
}

const CCF = "ConditionalCheckFailed";

export type TransactionOutcome =
  | { readonly kind: "committed"; readonly redone: boolean }
  /** `failed`: the indexes of the planned actions (after the fence and marker) whose condition failed. `evaluated`:
   *  DynamoDB evaluated the conditions (false: a rejection such as throttling -- a new attempt may succeed). */
  | { readonly kind: "definite"; readonly fenced: boolean; readonly evaluated: boolean; readonly failed: readonly number[]; readonly detail: string }
  | { readonly kind: "uncertain"; readonly detail: string };

export interface TransactionRunner {
  /** Send `[fence, marker, ...actions]` under a fresh token, and settle it. */
  run(actions: readonly TransactWriteItem[]): Promise<TransactionOutcome>;
}

export interface TransactionRunnerOptions {
  readonly fence: TransactWriteItem;
  readonly table: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Identical resends of an unknown outcome before it is declared uncertain. */
  readonly maxResends: number;
  /** The bound of each call it makes (default: the L5-1 call deadline). */
  readonly callDeadlineMs?: number;
}

/** Resend waits (ms), by attempt: short -- a transaction in progress completes in well under a second. */
const RESEND_WAITS = [50, 200, 800, 2_000];
/** A chunk refused WITHOUT being evaluated (throttled, a conflict: nothing was written) is retried as a new attempt, for
 *  about 15 s in all, whenever giving up would leave something behind: a LATER chunk (the chunks before it are committed:
 *  giving up is a change applied in part -- a restart; review F7), or ANY chunk once the caller's step has run (its
 *  security event is recorded: giving up leaves it unconfirmed; re-review N1). */
export const NOT_EVALUATED_RETRY_WAITS: readonly number[] = Object.freeze([50, 200, 800, 2_000, 4_000, 8_000]);
/** A grant write is best effort and holds the writer's queue while it runs: one resend, each call bounded short (F4). */
export const GRANT_CALL_DEADLINE_MS = 2_000;
/** Past this, a resend could fall outside the token's 10-minute idempotency window: only the marker read decides. */
const RESEND_WINDOW_MS = 8 * 60 * 1000;

export function transactionRunner(client: DynamoDBClient, options: TransactionRunnerOptions): TransactionRunner {
  const markerExists = async (token: string): Promise<boolean | null> => {
    try {
      const answer = await client.send(new GetItemCommand({ TableName: options.table, Key: keyAttributes(keys.marker(token)), ConsistentRead: true }), { abortSignal: deadline(options.callDeadlineMs) });
      return answer.Item !== undefined;
    } catch {
      return null;
    }
  };
  return {
    async run(actions) {
      const token = randomUUID();
      const started = options.now();
      const input: TransactWriteItemsCommandInput = {
        ClientRequestToken: token,
        TransactItems: [options.fence, { Put: { TableName: options.table, Item: markerItem(token, started), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } }, ...actions],
      };
      const analyse = (codes: readonly string[]) => ({
        fenced: codes[0] === CCF,
        marker: codes[1] === CCF,
        failed: codes.slice(2).flatMap((code, at) => (code === CCF ? [at] : [])),
      });
      const first = await sendTransaction(client, input, options.callDeadlineMs);
      if (first.kind === "ok") return { kind: "committed", redone: false };
      if (first.kind === "refused") return { kind: "definite", fenced: false, evaluated: false, failed: [], detail: first.detail };
      if (first.kind === "canceled") {
        const seen = analyse(first.codes);
        /* A marker already there can only be this token's own transaction (a fresh random token). */
        if (seen.marker) return { kind: "committed", redone: true };
        const evaluated = seen.fenced || seen.failed.length > 0;
        return { kind: "definite", fenced: seen.fenced, evaluated, failed: seen.failed, detail: first.detail };
      }
      /* UNKNOWN (or, impossibly for a fresh token, in progress): resend the identical request. */
      let last = first.detail;
      for (let resend = 0; resend < options.maxResends; resend += 1) {
        await options.sleep(RESEND_WAITS[Math.min(resend, RESEND_WAITS.length - 1)]);
        if (options.now() - started > RESEND_WINDOW_MS) break;
        const again = await sendTransaction(client, input, options.callDeadlineMs);
        if (again.kind === "ok") return { kind: "committed", redone: true };
        last = again.detail;
        if (again.kind === "in-progress" || again.kind === "unknown") continue;
        if (again.kind === "canceled") {
          const seen = analyse(again.codes);
          if (seen.marker) return { kind: "committed", redone: true };
          if (seen.fenced || seen.failed.length > 0) {
            /* Evaluated with our token and refused: the marker was absent then, and nothing is in progress. The strong
               read confirms it (a resend's refusal is never taken at face value). */
            const there = await markerExists(token);
            if (there === true) return { kind: "committed", redone: true };
            if (there === false) {
              return { kind: "definite", fenced: seen.fenced, evaluated: true, failed: seen.failed, detail: `${first.detail}; the identical resend was refused (${again.detail}) and its commit marker is not stored` };
            }
            continue;
          }
        }
        /* Refused without evaluating (throttled...), or cancelled without a failed condition: proves nothing yet. */
        if ((await markerExists(token)) === true) return { kind: "committed", redone: true };
      }
      const there = await markerExists(token);
      if (there === true) return { kind: "committed", redone: true };
      return { kind: "uncertain", detail: `${first.detail}; after the identical resends the outcome is still unknown (${last})` };
    },
  };
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface DynamoIdentityStoreOptions {
  /** The identity-writer role epoch this instance holds: ROLE_ID, a condition of every write it makes. */
  readonly epoch: number;
  readonly now?: () => number;
  /** Waits between resends (tests pass an immediate one; there are no timers in the conformance run). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Parallel segments of the load's strongly consistent scan. */
  readonly scanSegments?: number;
  readonly pageSize?: number;
  readonly maxResends?: number;
  /** The role was taken over: this writer is stale (L5-3/L5-7: exit 3 and restart as whatever routing says). */
  readonly onFenced?: (detail: string) => void;
  /** An outcome that could not be settled, a change applied in part, or a table that disagrees with this writer's
   *  view: the process must restart and load what the table really holds. */
  readonly onRestartRequired?: (detail: string) => void;
  readonly warn?: (line: string) => void;
  /** LIVE-6 L6-4, the RESTORE REPLAY's own store only: the table is mid-restore by THIS restore (its `RESTORE#identity`
   *  marker is `replaying` under this id), and it may be loaded to be replayed. Without it (every serving task), a table
   *  whose restore is not `complete` refuses the load (`IdentityRestoreIncompleteError`). */
  readonly restore?: { readonly id: string };
}

/** LIVE-6 L6-4: the identity table is a restored copy whose security-journal replay has not completed -- it serves
 *  nothing (no load, no serving takeover) until the replay marks it complete. Names no id. */
export class IdentityRestoreIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityRestoreIncompleteError";
  }
}

/** LIVE-6 L6-4: carried by every SERVING identity-writer takeover (`aws/ownership/roles.ts`), inside its transaction:
 *    - `ConditionCheck RESTORE#identity: attribute_not_exists(pk) OR (state = complete AND identity_table = this table)` --
 *      no serving task takes the role of a table mid-restore (so it never fences the replay preparing it), of a restore's
 *      superseded SOURCE, or of a copy that merely carried another table's `complete` marker;
 *    - `Update TABLE#identity SET identity_table = this table COND attribute_not_exists(pk) OR identity_table = this
 *      table` -- the table NAMES ITSELF from its first serving takeover on, so a point-in-time copy (which carries its
 *      source's name) serves nothing until its own restore replay completes and renames it (review round 2).
 *  The replay's own takeovers carry neither. */
export function identityServingChecks(table: string): TransactWriteItem[] {
  return [
    {
      ConditionCheck: {
        TableName: table,
        Key: keyAttributes(RESTORE_KEY),
        ConditionExpression: "attribute_not_exists(#pk) OR (#state = :complete AND #table = :table)",
        ExpressionAttributeNames: { "#pk": "pk", "#state": "state", "#table": "identity_table" },
        ExpressionAttributeValues: { ":complete": { S: "complete" }, ":table": { S: table } },
      },
    },
    {
      Update: {
        TableName: table,
        Key: keyAttributes(keys.self()),
        UpdateExpression: "SET #fmt = :fmt, #table = :table",
        ConditionExpression: "attribute_not_exists(#pk) OR #table = :table",
        ExpressionAttributeNames: { "#pk": "pk", "#fmt": "fmt", "#table": "identity_table" },
        ExpressionAttributeValues: { ":fmt": { N: "1" }, ":table": { S: table } },
      },
    },
  ];
}

/** The whole identity table, decoded strictly (the load's reading, shared with the restore's read-only planning). */
export interface IdentityTableContents {
  readonly snapshot: FullIdentitySnapshot;
  readonly role: RoleRecord | null;
  readonly restore: RestoreRecord | null;
  readonly reviews: readonly ReviewRecord[];
  readonly grants: number;
  /** The table's own name (`TABLE#identity`), `null` before its first serving takeover. */
  readonly self: string | null;
}

/** Decode every item of the identity table: strict, as the load always was -- one item it cannot read refuses the whole. */
export function decodeIdentityTable(items: readonly Item[], where: string): IdentityTableContents {
  const principals: Principal[] = [];
  const profiles: Profile[] = [];
  const sessions: Session[] = [];
  const families: SessionFamily[] = [];
  const links: LinkCredential[] = [];
  const selectors: SelectorRecord[] = [];
  const reviews: ReviewRecord[] = [];
  let roles = 0;
  let role: RoleRecord | null = null;
  let restores = 0;
  let restore: RestoreRecord | null = null;
  let grants = 0;
  let selves = 0;
  let self: string | null = null;
  for (const item of items) {
    const decoded = decodeItem(item);
    if ("problem" in decoded) throw new IdentityStoreCorruptError(`${where}: ${decoded.problem}`);
    switch (decoded.kind) {
      case "principal":
        principals.push(decoded.record);
        break;
      case "profile":
        profiles.push(decoded.record);
        break;
      case "session":
        sessions.push(decoded.record);
        break;
      case "family":
        families.push(decoded.record);
        break;
      case "link":
        links.push(decoded.record);
        break;
      case "selector":
        selectors.push(decoded.record);
        break;
      case "role":
        roles += 1;
        role = decoded.record;
        break;
      case "restore":
        restores += 1;
        restore = decoded.record;
        break;
      case "review":
        reviews.push(decoded.record);
        break;
      case "grant":
        grants += 1;
        break;
      case "self":
        selves += 1;
        self = decoded.record.identity_table;
        break;
      default:
        break; // commit markers: well-formed (decoded), not part of the identity set
    }
  }
  if (roles > 1) throw new IdentityStoreCorruptError(`${where}: more than one identity-writer role item`);
  if (restores > 1) throw new IdentityStoreCorruptError(`${where}: more than one restore marker`);
  if (selves > 1) throw new IdentityStoreCorruptError(`${where}: more than one table-name item`);
  /* The selector items are the uniqueness authority: they must say exactly what the profiles say. */
  const live = new Map<string, string>();
  for (const selector of selectors) if (selector.retired_at === null) live.set(selector.recovery_selector, selector.profile_id);
  if (live.size !== profiles.length) throw new IdentityStoreCorruptError(`${where}: the live selector items do not match the profiles (${live.size} for ${profiles.length})`);
  for (const profile of profiles) {
    if (live.get(profile.recovery_selector) !== profile.profile_id) throw new IdentityStoreCorruptError(`${where}: a profile's recovery selector has no live selector item naming it`);
  }
  const whole = checkSnapshot(applyChange({ principals, sessions, profiles, links, families }, {}), where);
  return { snapshot: applyChange(whole, {}), role, restore, reviews: reviews.sort((a, b) => (a.profile_id < b.profile_id ? -1 : a.profile_id > b.profile_id ? 1 : a.restore_id < b.restore_id ? -1 : 1)), grants, self };
}

/** Why `table`, in this restore state, may not be loaded by this store (`null`: it may). */
export function restoreLoadProblem(restore: RestoreRecord | null, own: { readonly id: string } | undefined, table: string, self: string | null = null): string | null {
  if (own !== undefined) {
    if (restore === null || restore.restore_id !== own.id || restore.state !== "replaying" || restore.identity_table !== table) return `the table is not mid-restore by ${own.id} (the restore replay loads only its own replaying table)`;
    return null;
  }
  if (restore !== null && restore.identity_table === table) {
    if (restore.state === "superseded") return `the table was superseded by an identity restore (${restore.restore_id}): it never serves again`;
    if (restore.state !== "complete") return `the table is a restored copy whose security-journal replay (${restore.restore_id}) has not completed: it serves nothing until the replay marks it complete`;
  }
  if (self !== null && self !== table) return `the table names itself ${self}: it is a copy of that table, and serves nothing until its own restore replay completes`;
  if (restore !== null && restore.identity_table !== table) return `the table carries another table's restore marker (${restore.restore_id}): it is a copy that was never replayed itself, and serves nothing`;
  return null;
}

export interface DynamoIdentityStoreHealth {
  readonly loaded: boolean;
  readonly epoch: number;
  readonly fenced: string | null;
  readonly poisoned: string | null;
  readonly sizes: { principals: number; sessions: number; profiles: number; links: number; families: number };
}

export interface DynamoIdentityStore extends IdentityStore {
  readonly table: string;
  /** Sensitive-auth grants, in the same table, under the same fence. */
  readonly grants: SensitiveAuthGrantStore;
  readonly stats: { commits: number; redone: number; definite: number; uncertain: number; chunked: number; fenced: number; divergences: number };
  health(): DynamoIdentityStoreHealth;
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function roleFence(table: string, epoch: number): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: table,
      Key: keyAttributes(ROLE_KEY),
      ConditionExpression: "#epoch = :epoch",
      ExpressionAttributeNames: { "#epoch": "epoch" },
      ExpressionAttributeValues: { ":epoch": { N: String(epoch) } },
    },
  };
}

export function createDynamoIdentityStore(client: DynamoDBClient, table: string, options: DynamoIdentityStoreOptions): DynamoIdentityStore {
  if (!Number.isSafeInteger(options.epoch) || options.epoch < 1) throw new Error("dynamo identity store: the role epoch must be a positive integer");
  const now = options.now ?? (() => Date.now());
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const segments = Math.max(1, Math.min(options.scanSegments ?? 4, 64));
  const pageSize = options.pageSize ?? 500;
  const stats = { commits: 0, redone: 0, definite: 0, uncertain: 0, chunked: 0, fenced: 0, divergences: 0 };
  const sleep = options.sleep ?? sleepReal;
  const runner = transactionRunner(client, { fence: roleFence(table, options.epoch), table, now, sleep, maxResends: options.maxResends ?? 3 });
  /* Grants (review F4): one resend, each call bounded short -- a grant is best effort, and it holds the queue. */
  const grantRunner = transactionRunner(client, { fence: roleFence(table, options.epoch), table, now, sleep, maxResends: Math.min(1, options.maxResends ?? 1), callDeadlineMs: GRANT_CALL_DEADLINE_MS });

  let index: IdentityIndex | null = null;
  let fenced: string | null = null;
  let poisoned: string | null = null;

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const markFenced = (detail: string) => {
    stats.fenced += 1;
    if (fenced !== null) return;
    fenced = detail;
    options.onFenced?.(detail);
  };
  const poison = (detail: string) => {
    if (poisoned !== null) return;
    poisoned = detail;
    options.onRestartRequired?.(detail);
  };
  const refuseIfHeld = () => {
    if (fenced !== null) throw new StoreDefiniteError(`this identity writer's role was taken over (${fenced}); nothing was written`);
    if (poisoned !== null) throw new StoreDefiniteError(`the identity store is held after an unresolved write (${poisoned}); nothing was written`);
  };
  const failedReasons = (actions: readonly PlannedAction[], failed: readonly number[]) =>
    failed.map((at) => `${actions[at]?.cls ?? "an item"}: ${(actions[at]?.reasons ?? []).join("; ") || "its condition"}`).join(" | ");

  async function scanAll(filter?: { expression: string; names: Record<string, string>; values: Record<string, AttributeValue> }): Promise<Item[]> {
    const out: Item[][] = await Promise.all(
      Array.from({ length: segments }, async (_, segment) => {
        const items: Item[] = [];
        let start: Record<string, AttributeValue> | undefined;
        do {
          const page = await client.send(
            new ScanCommand({
              TableName: table,
              ConsistentRead: true,
              Segment: segment,
              TotalSegments: segments,
              Limit: pageSize,
              ExclusiveStartKey: start,
              ...(filter === undefined ? {} : { FilterExpression: filter.expression, ExpressionAttributeNames: filter.names, ExpressionAttributeValues: filter.values }),
            }),
            { abortSignal: deadline() },
          );
          items.push(...((page.Items ?? []) as Item[]));
          start = page.LastEvaluatedKey;
        } while (start !== undefined);
        return items;
      }),
    );
    return out.flat();
  }

  const where = `identity table ${table}`;

  const load = (): Promise<FullIdentitySnapshot> =>
    serial(async () => {
      const contents = decodeIdentityTable(await scanAll(), where);
      /* LIVE-6 L6-4: a restored table serves nothing until its security-journal replay is complete -- a load of a
         half-replayed table could bring back a revoked family, a retired key or a disabled principal. */
      const restoring = restoreLoadProblem(contents.restore, options.restore, table, contents.self);
      if (restoring !== null) throw new IdentityRestoreIncompleteError(`${where}: ${restoring}`);
      /* Review F6: a writer whose epoch is not the table's learns it at the load, not at its first write -- it must not
         serve from memory what another writer may be changing (preflight §5.5). The load still answers (reading is
         harmless); every write is refused. */
      const tableEpoch = contents.role?.epoch ?? null;
      if (tableEpoch !== options.epoch) markFenced(`at the load the table's role epoch is ${tableEpoch ?? "absent"}; this writer holds ${options.epoch}`);
      const sorted = contents.snapshot;
      index = IdentityIndex.from(sorted);
      return JSON.parse(JSON.stringify(sorted)) as FullIdentitySnapshot;
    });

  const commit = (change: IdentityChange, commitOptions?: IdentityCommitOptions): Promise<void> =>
    serial(async () => {
      if (index === null) throw new StoreDefiniteError("the identity store has not been loaded; nothing was written");
      refuseIfHeld();
      const current = index;
      const problem = changeShapeProblem(change) ?? current.check(change, "identity commit") ?? preconditionFailure(current, change.expect);
      if (problem !== null) {
        stats.definite += 1;
        throw new StoreDefiniteError(`${problem}; nothing was written`);
      }
      const plan = planIdentityChange(change, { profileSelector: (id) => current.profiles.get(id)?.recovery_selector }, table, CHUNK_BUDGET);
      if (plan.kind === "refused") {
        stats.definite += 1;
        throw new StoreDefiniteError(`${plan.detail}; nothing was written`);
      }
      let stepRan = false;
      if (commitOptions?.beforeWrite !== undefined) {
        /* Review F2: the caller's step (the identity service's security event) runs after every check this writer can
           make -- including its fence, as far as a strong read can see it: a writer that was taken over learns it HERE,
           before its event is recorded. A takeover after this read is still refused inside the write (ROLE_ID). */
        let role: RoleRecord | null;
        try {
          role = await readIdentityRole(client, table);
        } catch (error) {
          stats.definite += 1;
          throw new StoreDefiniteError(`the identity-writer role could not be read before the write (${describe(error)}); nothing was written`);
        }
        if (role === null || role.epoch !== options.epoch) {
          markFenced(`the role epoch ${options.epoch} is no longer the table's`);
          stats.definite += 1;
          throw new StoreDefiniteError(`this identity writer's role was taken over (epoch ${options.epoch}); nothing was written`);
        }
        await commitOptions.beforeWrite();
        stepRan = true;
      }
      if (plan.chunks.length > 1) stats.chunked += 1;
      for (const [at, chunk] of plan.chunks.entries()) {
        const actions = chunk.actions.map((planned) => planned.action);
        let outcome = await runner.run(actions);
        /* A chunk refused WITHOUT being evaluated (throttled, a conflict: nothing written) is retried as a new attempt when
           answering now would leave something behind: the chunks before it (review F7), or the caller's recorded step
           (re-review N1). About 15 s. */
        for (let retry = 0; (at > 0 || stepRan) && retry < NOT_EVALUATED_RETRY_WAITS.length && outcome.kind === "definite" && !outcome.evaluated; retry += 1) {
          await sleep(NOT_EVALUATED_RETRY_WAITS[retry]);
          outcome = await runner.run(actions);
        }
        if (outcome.kind === "committed") {
          if (outcome.redone) stats.redone += 1;
          continue;
        }
        if (outcome.kind === "definite" && outcome.fenced) markFenced(`the role epoch ${options.epoch} is no longer the table's`);
        if (at === 0 && outcome.kind === "definite") {
          stats.definite += 1;
          if (outcome.fenced) throw new StoreDefiniteError(`this identity writer's role was taken over (epoch ${options.epoch}); nothing was written`);
          if (outcome.evaluated) {
            /* This writer's view accepted the change and the table refused it: the view is not the table. */
            stats.divergences += 1;
            const detail = `the stored identity refused a change this writer's view accepted (${failedReasons(chunk.actions, outcome.failed)})`;
            warn(`  identity store: ${detail}; holding for a restart`);
            poison(detail);
            throw new StoreDefiniteError(`${detail}; nothing was written`);
          }
          throw new StoreDefiniteError(`${outcome.detail}; nothing was written`);
        }
        stats.uncertain += 1;
        const detail =
          at === 0
            ? `the outcome of an identity commit is unknown (${(outcome as { detail: string }).detail})`
            : `an identity change was applied in part: ${at} of ${plan.chunks.length} transactions committed, then ${(outcome as { detail: string }).detail}`;
        poison(detail);
        throw new StoreUncertainError(detail);
      }
      current.apply(change);
      stats.commits += 1;
    });

  const grants: SensitiveAuthGrantStore = {
    put: (grant) =>
      serial(async () => {
        if (!isSensitiveAuthGrant(grant)) throw new StoreDefiniteError("not a sensitive-auth grant; nothing was written");
        refuseIfHeld();
        const outcome = await grantRunner.run([{ Put: { TableName: table, Item: grantItem(canonicalGrant(grant)) } }]);
        if (outcome.kind === "committed") return;
        if (outcome.kind === "definite") {
          if (outcome.fenced) markFenced(`the role epoch ${options.epoch} is no longer the table's`);
          throw new StoreDefiniteError(`${outcome.fenced ? "this identity writer's role was taken over" : outcome.detail}; the grant was not written`);
        }
        /* A grant can only ever ADD what the service's own state already allows, so an unknown grant write does not hold
           the store: either way is safe (identity/grants.ts). */
        throw new StoreUncertainError(outcome.detail);
      }),
    async get(sessionId) {
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
      const answer = await client.send(new GetItemCommand({ TableName: table, Key: keyAttributes(keys.grant(sessionId)), ConsistentRead: true }), { abortSignal: deadline() });
      if (answer.Item === undefined) return null;
      const decoded = decodeItem(answer.Item as Item);
      if ("problem" in decoded || decoded.kind !== "grant") throw new IdentityStoreCorruptError(`${where}: ${"problem" in decoded ? decoded.problem : "not a grant item"}`);
      return canonicalGrant(decoded.record);
    },
    async live(at) {
      const items = await scanAll({ expression: "begins_with(#pk, :grant)", names: { "#pk": "pk" }, values: { ":grant": { S: "GRANT#" } } });
      const out: SensitiveAuthGrant[] = [];
      for (const item of items) {
        const decoded = decodeItem(item);
        if ("problem" in decoded || decoded.kind !== "grant") throw new IdentityStoreCorruptError(`${where}: ${"problem" in decoded ? decoded.problem : "not a grant item"}`);
        if (at < decoded.record.expires_at) out.push(canonicalGrant(decoded.record));
      }
      return out.sort((a, b) => (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0));
    },
    remove: (sessionIds) =>
      serial(async () => {
        if (!Array.isArray(sessionIds) || !sessionIds.every((id) => typeof id === "string" && SESSION_ID_PATTERN.test(id))) {
          throw new StoreDefiniteError("a grant removal names something that is not a session id; nothing was written");
        }
        refuseIfHeld();
        const unique = [...new Set(sessionIds)];
        for (let from = 0; from < unique.length; from += CHUNK_BUDGET) {
          const slice = unique.slice(from, from + CHUNK_BUDGET);
          const outcome = await grantRunner.run(slice.map((id) => ({ Delete: { TableName: table, Key: keyAttributes(keys.grant(id)) } })));
          if (outcome.kind === "committed") continue;
          if (outcome.kind === "definite" && outcome.fenced) markFenced(`the role epoch ${options.epoch} is no longer the table's`);
          if (outcome.kind === "definite" && from === 0) throw new StoreDefiniteError(`${outcome.detail}; nothing was removed`);
          throw new StoreUncertainError(`grant removal: ${(outcome as { detail: string }).detail}`);
        }
      }),
  };

  return {
    table,
    grants,
    stats,
    load,
    commit,
    health: () => ({
      loaded: index !== null,
      epoch: options.epoch,
      fenced,
      poisoned,
      sizes: index?.sizes() ?? { principals: 0, sessions: 0, profiles: 0, links: 0, families: 0 },
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Taking the identity-writer role (preflight §4 row 27)               */
/* ------------------------------------------------------------------ */

export class IdentityRoleRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityRoleRefusedError";
  }
}

export interface IdentityRoleTakeover {
  /** Who is taking the role (diagnostic only; 1-128 printable characters). */
  readonly task: string;
  readonly pool: string;
  readonly now: () => number;
  /** Further conditions the takeover must meet atomically (L5-3: `SYSTEM/ROUTING primary_pool = :P` and
   *  `POOL#P writer_epoch = :E`, so only the current task of the primary pool can take the role). */
  readonly checks?: readonly TransactWriteItem[];
  readonly maxAttempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** LIVE-6 L6-4: why this table may not SERVE now (its restore marker and its own name, strongly; `null`: it may). */
export async function identityServingProblem(client: DynamoDBClient, table: string): Promise<string | null> {
  const self = await readIdentityTableSelf(client, table);
  return restoreLoadProblem(await readIdentityRestore(client, table), undefined, table, self);
}

/** LIVE-6 L6-4: the table's own name as its `TABLE#identity` item states it, strongly (`null`: no serving takeover has
 *  bound it yet). Strict: damage throws. (LIVE-6 final convergence: exported, unchanged, for the staging certification's
 *  identity binding -- `identityServingProblem` reads it exactly so.) */
export async function readIdentityTableSelf(client: DynamoDBClient, table: string): Promise<string | null> {
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: keyAttributes(keys.self()), ConsistentRead: true }), { abortSignal: deadline() });
  if (answer.Item === undefined) return null;
  const decoded = decodeItem(answer.Item as Item);
  if ("problem" in decoded || decoded.kind !== "self") throw new IdentityStoreCorruptError(`identity table ${table}: the table-name item is not well-formed`);
  return decoded.record.identity_table;
}

/** LIVE-6 L6-4: the restore marker, strongly (`null`: the table was never restored). Strict: damage throws. */
export async function readIdentityRestore(client: DynamoDBClient, table: string): Promise<RestoreRecord | null> {
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: keyAttributes(RESTORE_KEY), ConsistentRead: true }), { abortSignal: deadline() });
  if (answer.Item === undefined) return null;
  const decoded = decodeItem(answer.Item as Item);
  if ("problem" in decoded || decoded.kind !== "restore") throw new IdentityStoreCorruptError(`identity table ${table}: the restore marker is not well-formed`);
  return decoded.record;
}

/** Read the role item strongly (`null`: the role was never taken). */
export async function readIdentityRole(client: DynamoDBClient, table: string): Promise<RoleRecord | null> {
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: keyAttributes(ROLE_KEY), ConsistentRead: true }), { abortSignal: deadline() });
  if (answer.Item === undefined) return null;
  const decoded = decodeItem(answer.Item as Item);
  if ("problem" in decoded || decoded.kind !== "role") throw new IdentityStoreCorruptError(`identity table ${table}: the identity-writer role item is not well-formed`);
  return decoded.record;
}

/**
 * Take the identity-writer role: the epoch moves to exactly one more than it was, compare-and-swap, together with the
 * caller's `checks`. Returns the epoch this task now holds -- the ROLE_ID of every write it makes. Every writer that
 * held an earlier epoch is refused by DynamoDB from this moment on. Never guesses its epoch: an unknown outcome is
 * settled by reading the role item's `claim` (this attempt's token).
 */
export async function takeOverIdentityWriter(client: DynamoDBClient, table: string, takeover: IdentityRoleTakeover): Promise<{ readonly epoch: number }> {
  /* Review F3: the role item is written only as its codec reads it back. A task or pool it would refuse, written once,
     would make every later load and takeover refuse the table: a self-inflicted outage. Refused before anything is sent. */
  if (!isRoleText(takeover.task) || !isRoleText(takeover.pool)) {
    throw new IdentityRoleRefusedError("the identity-writer role was not taken: its task and pool must each be 1-128 printable characters without spaces (nothing was sent)");
  }
  const sleep = takeover.sleep ?? sleepReal;
  const checks = takeover.checks ?? [];
  for (let attempt = 0; attempt < (takeover.maxAttempts ?? 5); attempt += 1) {
    if (attempt > 0) await sleep(RESEND_WAITS[Math.min(attempt - 1, RESEND_WAITS.length - 1)]);
    const current = await readIdentityRole(client, table);
    const next = (current?.epoch ?? 0) + 1;
    const takenAt = takeover.now();
    if (!Number.isSafeInteger(takenAt) || takenAt < 0 || !Number.isSafeInteger(next)) {
      throw new IdentityRoleRefusedError("the identity-writer role was not taken: the takeover time is not a time in whole milliseconds (nothing was sent)");
    }
    const token = randomUUID();
    const input: TransactWriteItemsCommandInput = {
      ClientRequestToken: token,
      TransactItems: [
        ...checks,
        {
          Update: {
            TableName: table,
            Key: keyAttributes(ROLE_KEY),
            UpdateExpression: "SET #epoch = :next, #task = :task, #pool = :pool, #taken = :at, #claim = :claim",
            ConditionExpression: current === null ? "attribute_not_exists(#pk)" : "#epoch = :current",
            ExpressionAttributeNames: { "#epoch": "epoch", "#task": "task", "#pool": "pool", "#taken": "taken_at", "#claim": "claim", ...(current === null ? { "#pk": "pk" } : {}) },
            ExpressionAttributeValues: {
              ":next": { N: String(next) },
              ":task": { S: takeover.task },
              ":pool": { S: takeover.pool },
              ":at": { N: String(takenAt) },
              ":claim": { S: token },
              ...(current === null ? {} : { ":current": { N: String(current.epoch) } }),
            },
          },
        },
      ],
    };
    let answer = await sendTransaction(client, input);
    for (let resend = 0; (answer.kind === "unknown" || answer.kind === "in-progress") && resend < 3; resend += 1) {
      await sleep(RESEND_WAITS[resend]);
      answer = await sendTransaction(client, input);
    }
    if (answer.kind === "ok") return { epoch: next };
    if (answer.kind === "canceled") {
      const roleFailed = answer.codes[checks.length] === CCF;
      const checkFailed = answer.codes.slice(0, checks.length).some((code) => code === CCF);
      if (checkFailed) throw new IdentityRoleRefusedError(`the identity-writer role was not taken: a takeover condition does not hold (${answer.detail})`);
      if (!roleFailed) continue; // a conflict: try again
    }
    /* Refused, unknown, or the role moved under us: did THIS attempt land? Only its own claim says so. */
    const after = await readIdentityRole(client, table).catch(() => null);
    if (after !== null && after.claim === token) return { epoch: after.epoch };
  }
  throw new IdentityRoleRefusedError("the identity-writer role could not be taken (it kept moving, or the table did not answer)");
}
