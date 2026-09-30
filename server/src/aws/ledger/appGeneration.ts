// server/src/aws/ledger/appGeneration.ts
//
// ==================================================================
//  LIVE-6 L6-4: ADOPTING AN APP GENERATION -- THE LEDGER'S `APPGEN`, MOVED ONLY FORWARD, ONLY BY EXACT COMPARE-AND-SWAP
// ==================================================================
//
// The ledger (L5-5, its own account, never restored with the app) names the ONE app generation -- the one game table --
// that may touch it: every ledger write (settlement reservations, relayer attempts, the relayer fence, the SEC# security
// events) carries `ConditionCheck APPGEN: current_generation = :mine`, and every task's pool writer watches it
// (`generationProbe`: a moved generation is the task's LOSS, exit 3). Moving it is therefore THE fence of a restore
// (preflight §17.2 step 3): from the moment it lands, every task of the old generation can reserve nothing, record
// nothing, journal nothing, and exits at its next self-check; and no task configured for the old generation can start.
//
// THIS FILE IS THE RECOVERY/ADOPTION OPERATION ONLY. The first APPGEN (`{schema 1, current_generation N}`) is written by
// the first deployment's bootstrap (L5-8); this file never creates it and refuses to run without it.
//
// THE ITEMS (both in the ledger table):
//
//   APPGEN / APPGEN            bootstrap:  {schema 1, current_generation N}
//                              adopted:    {schema 1, current_generation M, previous_generation N, adopted_at, adopted_by,
//                                           restore_id, game_table, claim}
//                              Read STRICTLY here: exactly one of those two attribute sets; `schema` above 1 is a newer
//                              build's item (never read, never overwritten); anything else is damage. The fence readers
//                              (`dynamoSigningLedger.ts` parseAppGen, the conditions inside every ledger write) look only at
//                              `schema` and `current_generation`, so they read both forms unchanged.
//   APPGEN#HISTORY / GEN#<M:20> one item per adopted generation, written in the SAME transaction as the move and never
//                              changed: {schema 1, kind "appgen-adoption", generation M, previous_generation N, adopted_at,
//                              adopted_by, restore_id, game_table, claim}. `attribute_not_exists` -- so a generation number
//                              is adopted AT MOST ONCE, ever: the auditable evidence, and the guard against reuse.
//
// THE MOVE -- ONE TransactWriteItems, one fresh ClientRequestToken (= the `claim` of both items):
//   [0] Update APPGEN  SET the adopted fields
//                      COND schema = 1 AND current_generation = :expected AND <exactly the item READ: its claim, or no
//                           claim at all for the bootstrap item>
//   [1] Put APPGEN#HISTORY/GEN#<M>   COND attribute_not_exists(pk)
// Preconditions, all checked on STRONG reads before anything is sent (and the first two again inside the write):
//   - APPGEN exists and is readable; the caller states the generation it expects (`expected`) and it is the current one;
//   - the new generation is strictly greater (monotonic: never backwards, never the same) and has never been adopted
//     (no history item) -- and, since APPGEN only moves forward, no number below it can ever be current again, so there
//     is no ABA: an exact CAS on (schema, current_generation, claim) can only ever match the item that was read;
//   - the target game table has been PREPARED for exactly this adoption (`SYSTEM/GENERATION`: generation M, restored from
//     generation `expected`, the same restore id and table -- `aws/game/generationMarker.ts`): restored data is made
//     ready BEFORE the generation that will serve it is adopted (the restore sequence, L6-4 report §3). The marker lives in
//     the app account, so this is read and checked by the caller (`markerCheck`) -- an ordering rule, not a transaction.
//
// OUTCOMES (never guessed):
//   committed        the transaction landed (success, or the settling read shows OUR claim on APPGEN and the history).
//   already-adopted  this exact adoption (same expected, generation, restore id and table) is already complete -- by this
//                    run or an earlier attempt of it: an idempotent re-run writes nothing.
//   conflict         APPGEN is not what the caller expected (another adoption moved it, or it was moved further), or the
//                    target generation was adopted before by another run: NOTHING of this call was written, and nothing
//                    concurrent was overwritten.
//   refused          a precondition does not hold, or the service refused the request before evaluating it: nothing
//                    written.
//   unknown          no answer (a timeout, a 5xx) and the settling read found APPGEN still exactly as read: the write may
//                    still land. Ask again with the SAME request -- every attempt is conditioned on the same read value,
//                    so at most one attempt can ever land, and a re-run then answers `already-adopted`.
// Every outcome carries the evidence (both items as read after, with no secret: a generation number, table names, a
// restore id, an operator name, a request token).

import { randomUUID } from "crypto";
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { LEDGER_KEYS, LEDGER_SCHEMA } from "./dynamoSigningLedger";

type Item = Record<string, AttributeValue>;

export const APPGEN_HISTORY_PK = "APPGEN#HISTORY";
export const appgenHistoryKey = (generation: number): Item => ({ pk: { S: APPGEN_HISTORY_PK }, sk: { S: `GEN#${String(generation).padStart(20, "0")}` } });

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const RESTORE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TEXT = /^[\x21-\x7e]{1,128}$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AppGenerationUnreadableError extends Error {
  constructor(
    message: string,
    readonly format: "corrupt" | "newer",
  ) {
    super(message);
    this.name = "AppGenerationUnreadableError";
  }
}

export interface Adoption {
  readonly previous_generation: number;
  readonly adopted_at: number;
  readonly adopted_by: string;
  readonly restore_id: string;
  readonly game_table: string;
  readonly claim: string;
}

export interface AppGeneration {
  readonly current_generation: number;
  /** `null`: the bootstrap item (never moved). */
  readonly adoption: Adoption | null;
}

export interface AdoptionRecord extends Adoption {
  readonly generation: number;
}

const intOf = (value: AttributeValue | undefined, min: number): number | null => {
  const text = value?.N;
  if (text === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= min ? number : null;
};
const namesOf = (item: Item): string =>
  Object.keys(item)
    .filter((name) => item[name] !== undefined)
    .sort()
    .join(",");

function schemaGuard(item: Item, what: string): void {
  const text = item.schema?.N;
  if (text !== undefined && /^[0-9]{1,9}$/.test(text) && Number(text) > LEDGER_SCHEMA) {
    throw new AppGenerationUnreadableError(`the ledger's ${what} is schema ${text}, written by a newer build: never read or overwritten here`, "newer");
  }
  if (text !== String(LEDGER_SCHEMA)) throw new AppGenerationUnreadableError(`the ledger's ${what} has no readable schema`, "corrupt");
}

function adoptionFields(item: Item, what: string): Adoption {
  const previous = intOf(item.previous_generation, 1);
  const at = intOf(item.adopted_at, 0);
  const by = item.adopted_by?.S;
  const restoreId = item.restore_id?.S;
  const table = item.game_table?.S;
  const claim = item.claim?.S;
  if (previous === null || at === null || by === undefined || !TEXT.test(by) || restoreId === undefined || !RESTORE_ID.test(restoreId) || table === undefined || !TABLE_NAME.test(table) || claim === undefined || !TOKEN.test(claim)) {
    throw new AppGenerationUnreadableError(`the ledger's ${what} is damaged (an adoption field is not well-formed)`, "corrupt");
  }
  return { previous_generation: previous, adopted_at: at, adopted_by: by, restore_id: restoreId, game_table: table, claim };
}

const BOOTSTRAP_NAMES = "current_generation,pk,schema,sk";
const ADOPTED_NAMES = "adopted_at,adopted_by,claim,current_generation,game_table,pk,previous_generation,restore_id,schema,sk";
const HISTORY_NAMES = "adopted_at,adopted_by,claim,game_table,generation,kind,pk,previous_generation,restore_id,schema,sk";

/** APPGEN, strictly: the bootstrap form or the adopted form, nothing else. */
export function parseAppGeneration(item: Item): AppGeneration {
  schemaGuard(item, "APPGEN");
  if (item.pk?.S !== "APPGEN" || item.sk?.S !== "APPGEN") throw new AppGenerationUnreadableError("not the APPGEN item", "corrupt");
  const current = intOf(item.current_generation, 1);
  if (current === null) throw new AppGenerationUnreadableError("the ledger's APPGEN has no readable current_generation", "corrupt");
  const names = namesOf(item);
  if (names === BOOTSTRAP_NAMES) return { current_generation: current, adoption: null };
  if (names !== ADOPTED_NAMES) throw new AppGenerationUnreadableError(`the ledger's APPGEN has the attributes [${names}], not this build's`, "corrupt");
  const adoption = adoptionFields(item, "APPGEN");
  if (adoption.previous_generation >= current) throw new AppGenerationUnreadableError("the ledger's APPGEN names a previous generation that is not below the current one", "corrupt");
  return { current_generation: current, adoption };
}

/** One history item, strictly. */
export function parseAdoptionRecord(item: Item): AdoptionRecord {
  schemaGuard(item, "adoption history");
  const names = namesOf(item);
  if (names !== HISTORY_NAMES || item.pk?.S !== APPGEN_HISTORY_PK || item.kind?.S !== "appgen-adoption") throw new AppGenerationUnreadableError(`an adoption history item has the attributes [${names}], not this build's`, "corrupt");
  const generation = intOf(item.generation, 1);
  if (generation === null || item.sk?.S !== appgenHistoryKey(generation).sk.S) throw new AppGenerationUnreadableError("an adoption history item's key does not match its generation", "corrupt");
  const adoption = adoptionFields(item, "adoption history");
  if (adoption.previous_generation >= generation) throw new AppGenerationUnreadableError("an adoption history item does not move forward", "corrupt");
  return { generation, ...adoption };
}

async function readItem(client: DynamoDBClient, table: string, key: Item): Promise<Item | null> {
  const answer = await client.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item ?? null;
}

/** APPGEN as it stands, strongly consistent (`null`: never initialised). Throws for an item this build cannot read. */
export async function readAppGeneration(client: DynamoDBClient, table: string): Promise<AppGeneration | null> {
  const item = await readItem(client, table, LEDGER_KEYS.appgen());
  return item === null ? null : parseAppGeneration(item);
}

/** The adoption of `generation`, if one was ever made. */
export async function readAdoptionRecord(client: DynamoDBClient, table: string, generation: number): Promise<AdoptionRecord | null> {
  const item = await readItem(client, table, appgenHistoryKey(generation));
  return item === null ? null : parseAdoptionRecord(item);
}

/** Every adoption ever made, oldest first (strict: one damaged item refuses the whole answer). */
export async function listAdoptions(client: DynamoDBClient, table: string): Promise<AdoptionRecord[]> {
  const out: AdoptionRecord[] = [];
  let start: Item | undefined;
  do {
    const page = await client.send(
      new QueryCommand({ TableName: table, ConsistentRead: true, KeyConditionExpression: "#pk = :pk", ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: { ":pk": { S: APPGEN_HISTORY_PK } }, ExclusiveStartKey: start }),
      { abortSignal: deadline() },
    );
    for (const item of page.Items ?? []) out.push(parseAdoptionRecord(item as Item));
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start !== undefined);
  return out;
}

/* ------------------------------------------------------------------ */
/* The request, the plan (dry run), and the adoption                    */
/* ------------------------------------------------------------------ */

export interface AdoptionRequest {
  /** The generation the caller read and expects APPGEN to hold now (the one being superseded). */
  readonly expected: number;
  /** The generation to adopt: strictly greater, never adopted before. */
  readonly generation: number;
  /** The prepared game table of `generation` (as the runtime document will name it). */
  readonly gameTable: string;
  readonly restoreId: string;
  /** The operator run (diagnostic, recorded). */
  readonly by: string;
}

/** The caller's check that the target game table was prepared for exactly this adoption (`null`: it was). */
export type MarkerCheck = (request: AdoptionRequest) => Promise<string | null>;

export interface AdoptionEvidence {
  readonly ledger_table: string;
  readonly request: { readonly expected: number; readonly generation: number; readonly game_table: string; readonly restore_id: string; readonly by: string };
  /** APPGEN and the target's history item as read (before; and after, for a write). */
  readonly before: { readonly appgen: AppGeneration | null; readonly history: AdoptionRecord | null };
  readonly after: { readonly appgen: AppGeneration | null; readonly history: AdoptionRecord | null } | null;
  /** The request token of the write (= the claim it stamps), when one was sent. */
  readonly token: string | null;
}

export type AdoptionOutcome =
  | { readonly kind: "committed"; readonly evidence: AdoptionEvidence }
  | { readonly kind: "already-adopted"; readonly evidence: AdoptionEvidence }
  | { readonly kind: "conflict"; readonly detail: string; readonly evidence: AdoptionEvidence }
  | { readonly kind: "refused"; readonly detail: string; readonly evidence: AdoptionEvidence }
  | { readonly kind: "unknown"; readonly detail: string; readonly evidence: AdoptionEvidence };

export type AdoptionPlan =
  | { readonly kind: "ready"; readonly evidence: AdoptionEvidence }
  | Exclude<AdoptionOutcome, { kind: "committed" } | { kind: "unknown" }>;

export function adoptionRequestProblem(request: AdoptionRequest): string | null {
  if (!Number.isSafeInteger(request.expected) || request.expected < 1) return "the expected (current) generation must be a positive integer";
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) return "the generation to adopt must be a positive integer";
  if (request.generation <= request.expected) return `generation ${request.generation} does not move forward from ${request.expected}: APPGEN never moves backwards or stays (a generation is adopted once)`;
  if (!TABLE_NAME.test(request.gameTable)) return "the game table must be a DynamoDB table name";
  if (!RESTORE_ID.test(request.restoreId)) return "the restore id must be 3-64 lower-case letters, digits or dashes";
  if (!TEXT.test(request.by)) return "`by` must be 1-128 printable characters without spaces";
  return null;
}

/** Whether the history item and APPGEN show THIS adoption, complete. */
const isThisAdoption = (appgen: AppGeneration | null, history: AdoptionRecord | null, request: AdoptionRequest): boolean =>
  history !== null &&
  history.generation === request.generation &&
  history.previous_generation === request.expected &&
  history.restore_id === request.restoreId &&
  history.game_table === request.gameTable &&
  appgen !== null &&
  appgen.current_generation === request.generation &&
  appgen.adoption !== null &&
  appgen.adoption.claim === history.claim;

/**
 * The dry run: every precondition on strong reads, and the answer the adoption would give -- writes NOTHING. `ready`: an
 * `adoptGeneration` now would send the compare-and-swap.
 */
export async function planAdoption(client: DynamoDBClient, table: string, request: AdoptionRequest, markerCheck: MarkerCheck): Promise<AdoptionPlan> {
  const problem = adoptionRequestProblem(request);
  const evidence = (appgen: AppGeneration | null, history: AdoptionRecord | null): AdoptionEvidence => ({
    ledger_table: table,
    request: { expected: request.expected, generation: request.generation, game_table: request.gameTable, restore_id: request.restoreId, by: request.by },
    before: { appgen, history },
    after: null,
    token: null,
  });
  if (problem !== null) return { kind: "refused", detail: problem, evidence: evidence(null, null) };
  const appgen = await readAppGeneration(client, table);
  const history = await readAdoptionRecord(client, table, request.generation);
  const seen = evidence(appgen, history);
  if (appgen === null) return { kind: "refused", detail: "the ledger has no APPGEN: the first deployment's bootstrap (L5-8) initialises it; an adoption never creates it", evidence: seen };
  if (isThisAdoption(appgen, history, request)) return { kind: "already-adopted", evidence: seen };
  if (history !== null) {
    return { kind: "conflict", detail: `generation ${request.generation} was adopted before (restore ${history.restore_id}, from ${history.previous_generation}, table ${history.game_table}); a generation is never adopted twice`, evidence: seen };
  }
  if (appgen.current_generation !== request.expected) {
    return { kind: "conflict", detail: `APPGEN holds generation ${appgen.current_generation}, not the expected ${request.expected}: another adoption moved it (or the expectation is stale); nothing is overwritten`, evidence: seen };
  }
  const marker = await markerCheck(request);
  if (marker !== null) return { kind: "refused", detail: `the target game table is not prepared for this adoption: ${marker}`, evidence: seen };
  return { kind: "ready", evidence: seen };
}

type Sent = { readonly kind: "ok" } | { readonly kind: "cancelled"; readonly codes: readonly string[] } | { readonly kind: "definite"; readonly detail: string } | { readonly kind: "unknown"; readonly detail: string };

const REFUSED_BEFORE_EVALUATION = new Set([
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "ValidationException",
  "ResourceNotFoundException",
  "TransactionConflictException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "IdempotentParameterMismatchException",
]);

async function send(client: DynamoDBClient, items: TransactWriteItem[], token: string): Promise<Sent> {
  try {
    await client.send(new TransactWriteItemsCommand({ TransactItems: items, ClientRequestToken: token }), { abortSignal: deadline() });
    return { kind: "ok" };
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    if (name === "TransactionCanceledException") return { kind: "cancelled", codes: ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => reason.Code ?? "None") };
    if (REFUSED_BEFORE_EVALUATION.has(name)) return { kind: "definite", detail: `${name}` };
    return { kind: "unknown", detail: name || "no answer" };
  }
}

export interface AdoptOptions {
  readonly now: () => number;
  /** Identical resends of an unknown outcome before the settling read (default 3). */
  readonly resends?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Adopt `request.generation` (see the header). Every precondition is checked again here on strong reads (`planAdoption`),
 * then ONE compare-and-swap transaction is sent, and anything but a success is settled by reading the two items.
 */
export async function adoptGeneration(client: DynamoDBClient, table: string, request: AdoptionRequest, markerCheck: MarkerCheck, options: AdoptOptions): Promise<AdoptionOutcome> {
  const planned = await planAdoption(client, table, request, markerCheck);
  if (planned.kind !== "ready") return planned;
  const read = planned.evidence.before.appgen as AppGeneration;
  const at = Math.floor(options.now());
  if (!Number.isSafeInteger(at) || at < 0) return { kind: "refused", detail: "the clock gave no usable time; nothing was sent", evidence: planned.evidence };
  const token = randomUUID();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const resends = options.resends ?? 3;
  const N = (value: number): AttributeValue => ({ N: String(value) });
  const S = (value: string): AttributeValue => ({ S: value });
  /* The exact item read: (schema, current_generation) and its claim -- or, for the bootstrap item, no claim at all. */
  const readBinding =
    read.adoption === null
      ? { expression: "attribute_not_exists(#claim)", values: {} as Item }
      : { expression: "#claim = :readClaim", values: { ":readClaim": S(read.adoption.claim) } as Item };
  const items: TransactWriteItem[] = [
    {
      Update: {
        TableName: table,
        Key: LEDGER_KEYS.appgen(),
        UpdateExpression: "SET #cur = :next, #prev = :expected, #at = :at, #by = :by, #rid = :rid, #gt = :gt, #claim = :claim",
        ConditionExpression: `#schema = :schema AND #cur = :expected AND ${readBinding.expression}`,
        ExpressionAttributeNames: { "#schema": "schema", "#cur": "current_generation", "#prev": "previous_generation", "#at": "adopted_at", "#by": "adopted_by", "#rid": "restore_id", "#gt": "game_table", "#claim": "claim" },
        ExpressionAttributeValues: { ":schema": N(LEDGER_SCHEMA), ":expected": N(request.expected), ":next": N(request.generation), ":at": N(at), ":by": S(request.by), ":rid": S(request.restoreId), ":gt": S(request.gameTable), ":claim": S(token), ...readBinding.values },
      },
    },
    {
      Put: {
        TableName: table,
        Item: {
          ...appgenHistoryKey(request.generation),
          schema: N(LEDGER_SCHEMA),
          kind: S("appgen-adoption"),
          generation: N(request.generation),
          previous_generation: N(request.expected),
          adopted_at: N(at),
          adopted_by: S(request.by),
          restore_id: S(request.restoreId),
          game_table: S(request.gameTable),
          claim: S(token),
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "pk" },
      },
    },
  ];
  const withAfter = async (): Promise<AdoptionEvidence> => {
    const appgen = await readAppGeneration(client, table).catch(() => null);
    const history = await readAdoptionRecord(client, table, request.generation).catch(() => null);
    return { ...planned.evidence, after: { appgen, history }, token };
  };

  let sent = await send(client, items, token);
  /** Whether any attempt went unanswered: from then on an unchanged APPGEN proves nothing (it may still land). */
  const everUnknown = sent.kind === "unknown";
  let detail = sent.kind === "unknown" ? sent.detail : "";
  for (let resend = 0; sent.kind === "unknown" && resend < resends; resend += 1) {
    await sleep(Math.min(2_000, 250 * 2 ** resend));
    sent = await send(client, items, token); // the IDENTICAL request, the same token
    detail = `${detail}; resend ${resend + 1}: ${sent.kind === "unknown" || sent.kind === "definite" ? sent.detail : sent.kind}`;
  }
  if (sent.kind === "ok") return { kind: "committed", evidence: await withAfter() };
  if (sent.kind === "definite" && !everUnknown) {
    /* The FIRST (only) attempt was refused before evaluation (throttled, a transaction conflict on APPGEN, access):
       nothing was written. */
    return { kind: "refused", detail: `the service refused the adoption before evaluating it (${sent.detail}); nothing was written -- ask again`, evidence: await withAfter() };
  }
  /* Cancelled by a condition, or still unknown: the items as they stand decide -- never the error alone. */
  let appgen: AppGeneration | null;
  let history: AdoptionRecord | null;
  try {
    appgen = await readAppGeneration(client, table);
    history = await readAdoptionRecord(client, table, request.generation);
  } catch (error) {
    return { kind: "unknown", detail: `the adoption's outcome is unknown and the ledger could not be read back (${error instanceof Error ? error.message : String(error)})`, evidence: { ...planned.evidence, after: null, token } };
  }
  const evidence: AdoptionEvidence = { ...planned.evidence, after: { appgen, history }, token };
  if (appgen?.adoption?.claim === token && history?.claim === token) return { kind: "committed", evidence };
  if (appgen?.adoption?.claim === token || history?.claim === token) {
    return { kind: "unknown", detail: "only one of the adoption's two items carries this attempt's claim (impossible for one transaction): the ledger is not as this build expects; stop and inspect", evidence };
  }
  if (isThisAdoption(appgen, history, request)) return { kind: "already-adopted", evidence };
  const unchanged = appgen !== null && appgen.current_generation === read.current_generation && (appgen.adoption?.claim ?? null) === (read.adoption?.claim ?? null) && history === null;
  if (unchanged && everUnknown) {
    return { kind: "unknown", detail: `no answer (${detail}) and APPGEN is still exactly as read: the adoption may still land -- ask again with the same request (at most one attempt can ever land)`, evidence };
  }
  if (!unchanged) return { kind: "conflict", detail: `APPGEN or the target's history moved while this adoption ran (it now holds generation ${appgen?.current_generation ?? "none"}); nothing of this call was written or overwritten`, evidence };
  return { kind: "refused", detail: `the adoption was cancelled (${sent.kind === "cancelled" ? sent.codes.join(",") : "?"}) and nothing moved; nothing was written`, evidence };
}
