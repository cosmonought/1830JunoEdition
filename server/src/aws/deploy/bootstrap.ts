// server/src/aws/deploy/bootstrap.ts
//
// ==================================================================
//  LIVE-5 L5-8: THE FIRST START'S TWO CONTROL-PLANE RECORDS -- APPGEN AND SYSTEM/ROUTING -- WRITTEN ONCE, NEVER RESET
// ==================================================================
//
// The runtime cannot start without them (L5-7 §14) and never creates or repairs either (a task that did would be an
// authority over its own fences):
//
//   ledger  APPGEN / APPGEN            {schema 1, current_generation N}   the adopted app generation; the runtime reads it
//                                                                          before it takes its pool, and every ledger write
//                                                                          carries it as a condition
//   game    SYSTEM / ROUTING           {fmt 1, primary_pool, routing_version, updated_at, updated_by, claim}
//                                                                          which pool may take the singleton roles; written
//                                                                          ONLY by L5-3's `setPrimaryPool` (create-if-absent
//                                                                          here: expectedVersion null)
//
// Both are MUTABLE control-plane records (L6-2 flips the routing, L6-4 adopts a generation), so they are not Terraform
// items -- a later `terraform apply` would "correct" an operator's legitimate change back. This is the one deliberate,
// explicit, idempotent step between the IaC and the first task (infra/aws/README.md, deploy order step 5):
//
//   - explicit: the caller names the environment, the primary pool and the generation, and they must equal the runtime
//     document it points at (the CLI checks that, `tools/awsDeploy.ts`);
//   - idempotent for the SAME desired state: a record already equal to it is left untouched ("matches"), and a second run
//     writes nothing;
//   - it REFUSES rather than overwrite: a routing naming another pool, an APPGEN at another generation, or an item this
//     build cannot read is reported and nothing at all is written (both records are inspected before either is written);
//   - it never resets a routing version or a generation: the only writes are create-if-absent (`attribute_not_exists`
//     for APPGEN, `setPrimaryPool` with no expected version for the routing), so an existing record is never replaced;
//   - a lost answer is settled by reading the record back (equal: done; absent: unknown -- run it again; anything else:
//     conflict), never guessed;
//   - it prints identifiers and states only (there is no secret in either record).
//
// L6-3 owns richer inspection, repair and operator mutation (gamesDoctor over DynamoDB); this file does not flip, repair
// or adopt anything.

import { PutItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { primaryPoolProblem, readRouting, RoutingUnreadableError, setPrimaryPool, type RoutingRecord } from "../game/routing";
import { LEDGER_KEYS, LEDGER_SCHEMA, LedgerUnreadableError, readAdoptedGeneration } from "../ledger/dynamoSigningLedger";

export interface BootstrapTarget {
  /** The game table (its name in the app account's region). */
  readonly gameTable: string;
  /** The ledger table (its full ARN in production: cross-account). */
  readonly ledgerTable: string;
  /** The pool SYSTEM/ROUTING must name. */
  readonly primaryPool: string;
  /** The generation APPGEN must hold. */
  readonly generation: number;
  /** Who writes (the pipeline run, an operator): SYSTEM/ROUTING's `updated_by`, 1-128 printable characters, no spaces. */
  readonly by: string;
}

export interface BootstrapClients {
  /** The app account's region (the game table). */
  readonly app: DynamoDBClient;
  /** The ledger's region (the same client when they agree). */
  readonly ledger: DynamoDBClient;
}

/** One record as it stands, judged against the desired initial state. */
export type RecordState =
  | { readonly kind: "absent" }
  | { readonly kind: "matches"; readonly detail: string }
  /** Present and readable, but not the desired state: never overwritten. */
  | { readonly kind: "conflict"; readonly detail: string }
  /** Present but not readable by this build (damage, or a newer format): never overwritten, never guessed. */
  | { readonly kind: "unreadable"; readonly detail: string };

export interface BootstrapInspection {
  readonly appgen: RecordState;
  readonly routing: RecordState;
}

export type BootstrapOutcome =
  | { readonly kind: "bootstrapped"; readonly appgen: "created" | "matched"; readonly routing: "created" | "matched"; readonly inspection: BootstrapInspection }
  /** Nothing was written: an existing record is incompatible or unreadable. */
  | { readonly kind: "refused"; readonly reasons: readonly string[]; readonly inspection: BootstrapInspection };

/** A write whose outcome could not be settled: run the same command again (it can never write twice). */
export class BootstrapUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapUnknownError";
  }
}

class BootstrapConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapConflictError";
  }
}

const TEXT = /^[\x21-\x7e]{1,128}$/;

/** Why `target` cannot be bootstrapped at all (`null`: it can). Checked before anything is read. */
export function bootstrapTargetProblem(target: BootstrapTarget): string | null {
  const pool = primaryPoolProblem(target.primaryPool);
  if (pool !== null) return `primary pool: ${pool}`;
  if (!Number.isSafeInteger(target.generation) || target.generation < 1) return "the generation must be a positive whole number";
  if (!TEXT.test(target.by)) return "`by` must be 1-128 printable characters without spaces";
  if (target.gameTable.length === 0 || target.ledgerTable.length === 0) return "both tables must be named";
  return null;
}

const describe = (error: unknown): string => `${(error as { name?: string } | null)?.name ?? "Error"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);

/** APPGEN as it stands, against `target.generation` (a failed read throws). */
export async function appgenState(clients: Pick<BootstrapClients, "ledger">, target: Pick<BootstrapTarget, "ledgerTable" | "generation">): Promise<RecordState> {
  let adopted: number | null;
  try {
    adopted = await readAdoptedGeneration(clients.ledger, target.ledgerTable);
  } catch (error) {
    /* The strict parser refuses a damaged or newer APPGEN (`LedgerUnreadableError`); a read that failed proves nothing
       either. Neither is ever read as "absent". */
    if (error instanceof LedgerUnreadableError) return { kind: "unreadable", detail: `APPGEN is not readable by this build (${error.message})` };
    throw error;
  }
  if (adopted === null) return { kind: "absent" };
  if (adopted === target.generation) return { kind: "matches", detail: `APPGEN current_generation ${adopted}` };
  return { kind: "conflict", detail: `APPGEN already holds generation ${adopted}, not ${target.generation} (a generation is never reset here; adopting one is L6-4's)` };
}

const routingText = (routing: RoutingRecord) => `primary_pool ${routing.primary_pool}, routing_version ${routing.routing_version}, updated_by ${routing.updated_by}`;

/** SYSTEM/ROUTING as it stands, against `target.primaryPool` (a failed read throws). */
export async function routingState(clients: Pick<BootstrapClients, "app">, target: Pick<BootstrapTarget, "gameTable" | "primaryPool">): Promise<RecordState> {
  let routing: RoutingRecord | null;
  try {
    routing = await readRouting(clients.app, target.gameTable);
  } catch (error) {
    if (error instanceof RoutingUnreadableError) return { kind: "unreadable", detail: `SYSTEM/ROUTING is not readable by this build (${error.message})` };
    throw error;
  }
  if (routing === null) return { kind: "absent" };
  if (routing.primary_pool === target.primaryPool) return { kind: "matches", detail: routingText(routing) };
  return { kind: "conflict", detail: `SYSTEM/ROUTING already names ${routingText(routing)}, not ${target.primaryPool} (a routing flip is L6-2's, never the bootstrap's)` };
}

/** Both records as they stand (reads only; strongly consistent). A read that FAILS throws: nothing is inferred from it. */
export async function inspectBootstrap(clients: BootstrapClients, target: BootstrapTarget): Promise<BootstrapInspection> {
  const problem = bootstrapTargetProblem(target);
  if (problem !== null) throw new Error(`bootstrap: ${problem}`);
  return { appgen: await appgenState(clients, target), routing: await routingState(clients, target) };
}

const blocking = (inspection: BootstrapInspection): string[] =>
  (
    [
      ["APPGEN", inspection.appgen],
      ["SYSTEM/ROUTING", inspection.routing],
    ] as const
  ).flatMap(([name, state]) => (state.kind === "conflict" || state.kind === "unreadable" ? [`${name}: ${state.detail}`] : []));

/** Whether a dry run would write, refuse, or find everything in place. */
export function bootstrapPlan(inspection: BootstrapInspection): { readonly refused: readonly string[]; readonly writes: readonly string[] } {
  const writes: string[] = [];
  if (inspection.appgen.kind === "absent") writes.push("APPGEN (create-if-absent)");
  if (inspection.routing.kind === "absent") writes.push("SYSTEM/ROUTING (create-if-absent, routing_version 1)");
  return { refused: blocking(inspection), writes };
}

/** The APPGEN item, exactly: the ledger's key, `schema` and `current_generation` -- nothing else (L5-5's `parseAppGen`). */
export function appgenItem(generation: number): Record<string, { S: string } | { N: string }> {
  const key = LEDGER_KEYS.appgen();
  return { pk: key.pk as { S: string }, sk: key.sk as { S: string }, schema: { N: String(LEDGER_SCHEMA) }, current_generation: { N: String(generation) } };
}

async function createAppgen(clients: BootstrapClients, target: BootstrapTarget): Promise<void> {
  let failure: unknown = null;
  try {
    await clients.ledger.send(
      new PutItemCommand({ TableName: target.ledgerTable, Item: appgenItem(target.generation), ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } }),
      { abortSignal: deadline() },
    );
    return;
  } catch (error) {
    failure = error;
  }
  /* Refused by its condition or unknown: the item as it stands decides. */
  let now: RecordState;
  try {
    now = await appgenState(clients, target);
  } catch (error) {
    throw new BootstrapUnknownError(`APPGEN: the write's outcome is not known (${describe(failure)}) and the read-back failed (${describe(error)}); run the same bootstrap again`);
  }
  if (now.kind === "matches") return; // ours landed, or an identical one: the desired state either way
  if (now.kind === "absent") throw new BootstrapUnknownError(`APPGEN: the write's outcome is not known (${describe(failure)}) and nothing is there; run the same bootstrap again`);
  throw new BootstrapConflictError(`APPGEN: ${now.detail}`);
}

async function createRouting(clients: BootstrapClients, target: BootstrapTarget, now: number): Promise<void> {
  /* L5-3's own writer: a strict read, then create-if-absent (expectedVersion null) stamped with a fresh claim; a lost
     answer is settled by reading the claim back. It never replaces an existing routing. */
  let outcome;
  try {
    outcome = await setPrimaryPool(clients.app, target.gameTable, { pool: target.primaryPool, expectedVersion: null, by: target.by, now });
  } catch (error) {
    if (error instanceof RoutingUnreadableError) throw new BootstrapConflictError(`SYSTEM/ROUTING is not readable by this build (${error.message})`);
    /* A failed read or an unsettled write: create-if-absent can never write twice, so the same command is safe again. */
    throw new BootstrapUnknownError(`SYSTEM/ROUTING: ${describe(error)}; run the same bootstrap again`);
  }
  if (outcome.kind === "set") return;
  /* Someone created a routing meanwhile: it is acceptable only if it names the same pool. */
  if (outcome.current !== null && outcome.current.primary_pool === target.primaryPool) return;
  throw new BootstrapConflictError(`SYSTEM/ROUTING: created meanwhile as ${outcome.current === null ? "(gone again)" : routingText(outcome.current)}, not ${target.primaryPool}`);
}

/**
 * The bootstrap: inspect both, refuse (writing nothing) if either is incompatible or unreadable, else create what is
 * absent -- APPGEN first (the runtime reads it before anything else), then the routing -- and inspect again. Throws
 * `BootstrapUnknownError` when a write's outcome cannot be settled (run it again), and rethrows a failed read.
 */
export async function applyBootstrap(clients: BootstrapClients, target: BootstrapTarget, options: { readonly now: () => number }): Promise<BootstrapOutcome> {
  const before = await inspectBootstrap(clients, target);
  const refused = blocking(before);
  if (refused.length > 0) return { kind: "refused", reasons: refused, inspection: before };
  try {
    if (before.appgen.kind === "absent") await createAppgen(clients, target);
    if (before.routing.kind === "absent") await createRouting(clients, target, options.now());
  } catch (error) {
    if (error instanceof BootstrapConflictError) return { kind: "refused", reasons: [error.message], inspection: await inspectBootstrap(clients, target) };
    throw error;
  }
  const after = await inspectBootstrap(clients, target);
  if (after.appgen.kind !== "matches" || after.routing.kind !== "matches") {
    const reasons = [
      after.appgen.kind === "matches" ? null : `APPGEN is ${after.appgen.kind} after the bootstrap`,
      after.routing.kind === "matches" ? null : `SYSTEM/ROUTING is ${after.routing.kind} after the bootstrap`,
    ].filter((reason): reason is string => reason !== null);
    return { kind: "refused", reasons, inspection: after };
  }
  return { kind: "bootstrapped", appgen: before.appgen.kind === "absent" ? "created" : "matched", routing: before.routing.kind === "absent" ? "created" : "matched", inspection: after };
}
