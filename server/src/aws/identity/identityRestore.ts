// server/src/aws/identity/identityRestore.ts
//
// ==================================================================
//  LIVE-6 L6-4: THE IDENTITY RESTORE -- THE SECURITY JOURNAL REPLAYED INTO A RESTORED IDENTITY TABLE (preflight §17.3)
// ==================================================================
//
// The identity table is restored (point-in-time, into a NEW table) only for its own loss or corruption. The ledger's
// security-event journal is outside that restore domain; this module replays it into the restored table so that no
// security action is undone, and signs every session out (the rules and their properties: `identity/securityReplay.ts`).
//
// THE ORDER (`applyIdentityRestore`), each step only after the one before it succeeded:
//   0. read the restored table's RESTORE marker (strictly). `complete` by THIS restore ON THIS TABLE: answer
//      `already-complete` and write NOTHING (a re-run never touches a table that may be serving). `replaying` by another
//      restore, for another restore point, or from another source: refused. A marker a copy merely carried (it names
//      another table) is no answer: a fresh replay may begin over exactly it. A FRESH replay also requires the table to
//      hold nothing stamped after the restore point (+15 min): never the serving table, never a later copy.
//   1. THE SOURCE: the identity table the restore was made FROM. Its identity-writer role is taken over by this operator
//      run (epoch + 1) -- from that write on, no straggler of the old deployment can commit a security change there
//      (ROLE_ID inside every identity write), and a live one learns it at its next self-check (exit 3). So every security
//      change that ever COMMITTED has its event durable in the journal BEFORE this read-back can happen (journal first):
//      the journal read in step 4 misses no committed change. The source is then marked SUPERSEDED (its own RESTORE
//      marker, under that role): no serving task ever takes its role again or loads it -- an old task restarted with the
//      old runtime document cannot commit a security change the restored table would never see (review F2). A source
//      that no longer exists is asserted `gone` and VERIFIED; an existing source is always fenced and superseded.
//   2. THE TARGET's identity-writer role is taken by this run (no routing or pool condition: an operator run, pool
//      `op:restore`). Every write below carries it (ROLE_ID) and the transaction marker, like every identity write.
//   3. THE MARKER is written `replaying` (create-if-absent, or over exactly a PREVIOUS restore's `complete` marker the copy
//      carried): from here the table serves NOTHING -- a serving load refuses it (`IdentityRestoreIncompleteError`) and a
//      serving takeover is refused inside its own transaction (`identityServingCheck`). Its `started_at` is the replay's
//      one fixed time; a resumed replay reads it back instead of taking a new one.
//   4. THE JOURNAL: every `SEC#` item (a strict scan: one malformed item stops the replay). Its digest is recorded on the
//      marker (compare-and-swap on exactly the marker read).
//   5. THE LOAD (the store opened for the role's epoch and THIS restore) and THE PLAN (pure).
//   6. PER PRINCIPAL, in id order: its review record (if any) first, then its change (every precondition a condition,
//      the store's chunking and settlement unchanged). Then every sensitive-auth grant item is removed.
//   7. VERIFY: the journal read again must have the SAME digest (else a writer is still appending: stop, fail closed --
//      the marker stays `replaying`); the table loaded again must plan NO change and hold exactly the planned reviews.
//   8. The marker compare-and-swaps `replaying` -> `complete` (same restore, same digest). Only now may the table serve.
// INTERRUPTED ANYWHERE: nothing serves (the marker is `replaying` from step 3 on); a re-run with the same restore id takes
// the roles again and resumes -- the plan is computed from the table as it stands, and is exactly what is left. A
// confirmation that landed since (best effort, late) is honoured: the replay withdraws its OWN review of that profile.
// THE MARKER BINDS ITS TABLE: it serves only `complete` and naming this very table (`restoreLoadProblem`,
// `identityServingCheck`); a copy of a restored table, a superseded source and a table mid-replay serve nothing.
//
// `planIdentityRestore` is the DRY RUN: the same reads (the source's existence, the marker, the table, the journal) and
// the same plan, and NO write of any kind (no role taken, no marker, no change).
//
// OUTPUT carries counts, generation-free ids of profiles/principals/events for the reviews, epochs, and the journal's
// digest -- never a selector, a digest of a key, a session id or any secret.

import { ScanCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { deadline } from "../awsClients";
import { canonicalJournal, planSecurityReplay, SecurityReplayError, type ReplayPlan, type ReplayReport, type ReviewDraft } from "../../identity/securityReplay";
import { SecurityJournalCorruptError, type SecurityEvent } from "../../identity/securityEvents";
import type { FullIdentitySnapshot } from "../../identity/store";
import { StoreDefiniteError } from "../../persistence/storeResult";
import { scanSecurityJournal } from "./dynamoSecurityJournal";
import {
  createDynamoIdentityStore,
  decodeIdentityTable,
  IdentityRoleRefusedError,
  readIdentityRestore,
  readIdentityRole,
  restoreLoadProblem,
  roleFence,
  takeOverIdentityWriter,
  transactionRunner,
  type IdentityTableContents,
  type TransactionRunner,
} from "./dynamoIdentityStore";
import { eventIdList, isRoleText, keyAttributes, keys, RESTORE_ID_PATTERN, restoreItem, reviewItem, selfItem, type Item, type RestoreRecord, type ReviewRecord } from "./identityItems";

export const RESTORE_POOL = "op:restore";
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

export interface IdentityRestoreRequest {
  /** The RESTORED identity table (a new table from a point-in-time restore; never the one serving). */
  readonly table: string;
  readonly restoreId: string;
  /** The point in time the table was restored to (epoch ms). Recorded; the replay applies the whole journal. */
  readonly restorePoint: number;
  /** The table the restore was made from: fenced (it exists), or asserted gone (verified). */
  readonly source: { readonly kind: "fence"; readonly table: string } | { readonly kind: "gone"; readonly table: string };
  /** This operator run, as the role items name it (1-128 printable characters, no space). */
  readonly by: string;
}

export interface IdentityRestoreDeps {
  /** The app account's client (the identity tables). */
  readonly client: DynamoDBClient;
  /** The ledger (the SEC# journal), read only. */
  readonly ledger: { readonly client: DynamoDBClient; readonly table: string };
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly scanSegments?: number;
  /** Tests: stop after this many principal replays (an interruption), before verification. */
  readonly stopAfter?: number;
}

export interface ReviewSummary {
  readonly profile_id: string;
  readonly principal_id: string;
  readonly unconfirmed_events: readonly string[];
  readonly confirmed_events: readonly string[];
  readonly selector_state: ReviewDraft["selector_state"];
  readonly evidence: ReviewDraft["evidence"];
}

export interface IdentityRestoreReport {
  readonly restore_id: string;
  readonly table: string;
  readonly source: { readonly table: string; readonly state: "fenced" | "gone" | "exists" | "not-checked"; readonly role_epoch: number | null };
  readonly marker_before: { readonly state: RestoreRecord["state"] | "absent"; readonly restore_id: string | null };
  readonly target_role_epoch: number | null;
  readonly started_at: number | null;
  readonly journal: { readonly digest: string; readonly events: number } | null;
  readonly plan: ReplayReport | null;
  readonly reviews: readonly ReviewSummary[];
  readonly applied: { readonly principals: number; readonly grants_removed: number } | null;
}

export type IdentityRestoreOutcome =
  | { readonly kind: "planned"; readonly report: IdentityRestoreReport }
  | { readonly kind: "complete"; readonly report: IdentityRestoreReport }
  | { readonly kind: "already-complete"; readonly report: IdentityRestoreReport }
  /** Stopped before completion (the table still serves nothing); a re-run with the same request resumes. */
  | { readonly kind: "incomplete"; readonly detail: string; readonly report: IdentityRestoreReport }
  | { readonly kind: "refused"; readonly detail: string; readonly report: IdentityRestoreReport };

/** How far past the restore point a record of the restored copy may be stamped (writer clocks, and a commit that landed
 *  after its own stamp): a table holding anything newer is not a restore to that point. */
export const RESTORE_POINT_ALLOWANCE_MS = 15 * 60 * 1000;

/** Why the table cannot be a point-in-time copy made at `restorePoint` (`null`: it can): a record created after it.
 *  Checked only before the replay's first write (the replay itself makes records from later events). The guard against
 *  replaying into the wrong table -- the one still serving, or a later copy. */
export function restorePointProblem(snapshot: FullIdentitySnapshot, restorePoint: number): string | null {
  const stamps = [
    ...snapshot.principals.map((record) => Math.max(record.created_at, record.last_seen_at)),
    ...snapshot.sessions.map((record) => Math.max(record.created_at, record.last_seen_at, record.revoked_at ?? 0)),
    ...snapshot.families.map((record) => Math.max(record.created_at, record.revoked_at ?? 0)),
    ...snapshot.profiles.map((record) => Math.max(record.created_at, record.recovery_rotated_at)),
    ...snapshot.links.map((record) => Math.max(record.created_at, record.consumed_at ?? 0)),
  ];
  const newest = stamps.length === 0 ? 0 : Math.max(...stamps);
  if (newest > restorePoint + RESTORE_POINT_ALLOWANCE_MS) {
    return `the table holds records created ${Math.round((newest - restorePoint) / 60_000)} minutes after the restore point: it is not a copy restored to that point (the serving table, or another copy?) -- nothing is written`;
  }
  return null;
}

export function identityRestoreRequestProblem(request: IdentityRestoreRequest): string | null {
  if (!TABLE_NAME.test(request.table) || !TABLE_NAME.test(request.source.table)) return "the tables must be DynamoDB table names";
  if (request.table === request.source.table) return "the restored table must be a NEW table, not its source (a point-in-time restore never writes over its source)";
  if (!RESTORE_ID_PATTERN.test(request.restoreId)) return "the restore id must be 3-64 lower-case letters, digits or dashes";
  if (!Number.isSafeInteger(request.restorePoint) || request.restorePoint < 0) return "the restore point must be whole milliseconds";
  if (!isRoleText(request.by)) return "`by` must be 1-128 printable characters without spaces";
  return null;
}

const summaryOf = (review: ReviewDraft): ReviewSummary => ({
  profile_id: review.profile_id,
  principal_id: review.principal_id,
  unconfirmed_events: [...review.unconfirmed_events],
  confirmed_events: [...review.confirmed_events],
  selector_state: review.selector_state,
  evidence: { ...review.evidence },
});

const reviewRecordOf = (review: ReviewDraft, restoreId: string, at: number): ReviewRecord => ({
  profile_id: review.profile_id,
  principal_id: review.principal_id,
  restore_id: restoreId,
  reason: "unconfirmed-recovery-key-rotation",
  opened_at: at,
  unconfirmed_events: eventIdList(review.unconfirmed_events),
  confirmed_events: eventIdList(review.confirmed_events),
  selector_state: review.selector_state,
  prior_status: review.prior_status,
  resolved_at: null,
});

/** The whole identity table, read only (strongly consistent parallel scan), decoded strictly. */
export async function readIdentityTable(client: DynamoDBClient, table: string, segments = 4): Promise<IdentityTableContents> {
  const count = Math.max(1, Math.min(segments, 64));
  const parts = await Promise.all(
    Array.from({ length: count }, async (_, segment) => {
      const items: Item[] = [];
      let start: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(new ScanCommand({ TableName: table, ConsistentRead: true, Segment: segment, TotalSegments: count, ExclusiveStartKey: start }), { abortSignal: deadline() });
        items.push(...((page.Items ?? []) as Item[]));
        start = page.LastEvaluatedKey;
      } while (start !== undefined);
      return items;
    }),
  );
  return decodeIdentityTable(parts.flat(), `identity table ${table}`);
}

/** Whether the source table exists (its role item read strongly): `gone` only on the service's own "no such table". */
async function sourceState(client: DynamoDBClient, table: string): Promise<{ readonly state: "exists" | "gone"; readonly epoch: number | null }> {
  try {
    const role = await readIdentityRole(client, table);
    return { state: "exists", epoch: role?.epoch ?? null };
  } catch (error) {
    if ((error as { name?: string }).name === "ResourceNotFoundException") return { state: "gone", epoch: null };
    throw error;
  }
}

function emptyReport(request: IdentityRestoreRequest): IdentityRestoreReport {
  return {
    restore_id: request.restoreId,
    table: request.table,
    source: { table: request.source.table, state: "not-checked", role_epoch: null },
    marker_before: { state: "absent", restore_id: null },
    target_role_epoch: null,
    started_at: null,
    journal: null,
    plan: null,
    reviews: [],
    applied: null,
  };
}

/**
 * THE DRY RUN: the source's state, the marker, the table and the whole journal are read; the plan is computed with the
 * time a run would use; NOTHING is written (no role, no marker, no change).
 */
export async function planIdentityRestore(deps: IdentityRestoreDeps, request: IdentityRestoreRequest): Promise<IdentityRestoreOutcome> {
  let report = emptyReport(request);
  const problem = identityRestoreRequestProblem(request);
  if (problem !== null) return { kind: "refused", detail: problem, report };
  const source = await sourceState(deps.client, request.source.table);
  report = { ...report, source: { table: request.source.table, state: source.state, role_epoch: source.epoch } };
  if (request.source.kind === "gone" && source.state !== "gone") return { kind: "refused", detail: `the source table ${request.source.table} exists: it must be fenced, not asserted gone`, report };
  if (request.source.kind === "fence" && source.state === "gone") return { kind: "refused", detail: `the source table ${request.source.table} does not exist: assert it gone instead`, report };
  const contents = await readIdentityTable(deps.client, request.table, deps.scanSegments);
  const marker = contents.restore;
  report = { ...report, marker_before: { state: marker?.state ?? "absent", restore_id: marker?.restore_id ?? null } };
  if (completedHere(marker, request)) return { kind: "already-complete", report };
  const stop = targetMarkerProblem(marker, request);
  if (stop !== null) return { kind: "refused", detail: stop, report };
  const resumed = resumable(marker, request);
  const notACopy = resumed ? null : restorePointProblem(contents.snapshot, request.restorePoint);
  if (notACopy !== null) return { kind: "refused", detail: notACopy, report };
  const at = resumed ? (marker as RestoreRecord).started_at : Math.floor(deps.now());
  let plan: ReplayPlan;
  try {
    plan = planSecurityReplay({ snapshot: contents.snapshot, events: await scanSecurityJournal(deps.ledger.client, deps.ledger.table, { segments: deps.scanSegments }), restoreId: request.restoreId, at, ...reviewInputs(contents, request) });
  } catch (error) {
    if (error instanceof SecurityReplayError || error instanceof SecurityJournalCorruptError) return { kind: "refused", detail: `the journal cannot be replayed without guessing: ${error.message}`, report };
    throw error;
  }
  return { kind: "planned", report: { ...report, started_at: at, journal: plan.journal, plan: plan.report, reviews: plan.reviews.map(summaryOf) } };
}

/** This restore's own completed marker on this very table (a copy carrying it is not). */
const completedHere = (marker: RestoreRecord | null, request: IdentityRestoreRequest): boolean => marker !== null && marker.state === "complete" && marker.restore_id === request.restoreId && marker.identity_table === request.table;
/** A marker this replay continues: its own `replaying` marker on this table. */
const resumable = (marker: RestoreRecord | null, request: IdentityRestoreRequest): marker is RestoreRecord => marker !== null && marker.state === "replaying" && marker.identity_table === request.table;

/** Why a marker found on the target stops this request before anything is written (`null`: go on). */
function targetMarkerProblem(marker: RestoreRecord | null, request: IdentityRestoreRequest): string | null {
  if (marker === null) return null;
  if (marker.state === "superseded" && marker.identity_table === request.table) return `the table is itself the superseded SOURCE of restore ${marker.restore_id}: it is never a restore target`;
  if (!resumable(marker, request)) return null; // a carried or earlier-completed marker: a fresh replay may begin over exactly it
  if (marker.restore_id !== request.restoreId) return `the table is mid-restore by ${marker.restore_id}`;
  if (marker.restore_point !== request.restorePoint) return "the table's replaying marker names another restore point";
  if (marker.peer_table !== request.source.table) return `the table's replaying marker names another source (${marker.peer_table}): a resumed replay keeps its source`;
  return null;
}

const reviewInputs = (contents: IdentityTableContents, _request: IdentityRestoreRequest) => ({ reviews: contents.reviews.map((review) => ({ profile_id: review.profile_id, restore_id: review.restore_id, resolved_at: review.resolved_at, prior_status: review.prior_status })) });

/** One raw identity write under this run's fence (the marker, a review record): committed, or throw. */
async function write(runner: TransactionRunner, action: TransactWriteItem, what: string): Promise<void> {
  const outcome = await runner.run([action]);
  if (outcome.kind === "committed") return;
  if (outcome.kind === "definite") throw new StoreDefiniteError(`${what}: ${outcome.fenced ? "this run's identity-writer role was taken over" : outcome.evaluated ? "its condition does not hold" : outcome.detail}; nothing was written`);
  throw new Error(`${what}: the outcome is unknown (${outcome.detail}); re-run the replay`);
}

/** Apply (or resume) the identity restore (see the header). */
export async function applyIdentityRestore(deps: IdentityRestoreDeps, request: IdentityRestoreRequest): Promise<IdentityRestoreOutcome> {
  let report = emptyReport(request);
  const problem = identityRestoreRequestProblem(request);
  if (problem !== null) return { kind: "refused", detail: problem, report };
  const now = () => Math.floor(deps.now());

  /* 0. The marker first: a completed restore is never touched again (the table may be serving). */
  const before = await readIdentityRestore(deps.client, request.table);
  report = { ...report, marker_before: { state: before?.state ?? "absent", restore_id: before?.restore_id ?? null } };
  if (completedHere(before, request)) return { kind: "already-complete", report };
  const stop = targetMarkerProblem(before, request);
  if (stop !== null) return { kind: "refused", detail: stop, report };

  /* A fresh replay only on a true copy made at the restore point (never the serving table, never a later copy). */
  if (!resumable(before, request)) {
    const notACopy = restorePointProblem((await readIdentityTable(deps.client, request.table, deps.scanSegments)).snapshot, request.restorePoint);
    if (notACopy !== null) return { kind: "refused", detail: notACopy, report };
  }

  /* Before ANY write (the source's fence and supersession are permanent): the journal is read, and the replay planned
     against the table as it stands, read only. A journal that cannot be read or replayed without guessing is refused
     here -- never after the source was superseded (review round 2, N2). The verification (step 7) still compares the
     journal the replay ran on with the journal at its end. */
  try {
    const preJournal = await scanSecurityJournal(deps.ledger.client, deps.ledger.table, { segments: deps.scanSegments });
    const preContents = await readIdentityTable(deps.client, request.table, deps.scanSegments);
    planSecurityReplay({ snapshot: preContents.snapshot, events: preJournal, restoreId: request.restoreId, at: resumable(before, request) ? before.started_at : now(), ...reviewInputs(preContents, request) });
  } catch (error) {
    if (error instanceof SecurityReplayError || error instanceof SecurityJournalCorruptError) return { kind: "refused", detail: `the journal cannot be replayed without guessing: ${error.message}; nothing was written (the source was not fenced)`, report };
    throw error;
  }

  /* 1. The source: fenced, or verified gone. */
  const source = await sourceState(deps.client, request.source.table);
  if (request.source.kind === "gone") {
    if (source.state !== "gone") return { kind: "refused", detail: `the source table ${request.source.table} exists: it must be fenced, not asserted gone`, report: { ...report, source: { table: request.source.table, state: "exists", role_epoch: source.epoch } } };
    report = { ...report, source: { table: request.source.table, state: "gone", role_epoch: null } };
  } else {
    if (source.state === "gone") return { kind: "refused", detail: `the source table ${request.source.table} does not exist: assert it gone instead`, report: { ...report, source: { table: request.source.table, state: "gone", role_epoch: null } } };
    let fenced: { readonly epoch: number };
    try {
      fenced = await takeOverIdentityWriter(deps.client, request.source.table, { task: request.by, pool: RESTORE_POOL, now, ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}) });
    } catch (error) {
      if (error instanceof IdentityRoleRefusedError) return { kind: "incomplete", detail: `the source's identity-writer role could not be fenced (${error.message}); nothing of the replay was written`, report };
      throw error;
    }
    /* ... and SUPERSEDED, for good: its RESTORE marker says so, so no serving task ever takes its role again (the
       serving takeover's own condition) or loads it -- an old task restarted with the old runtime document cannot commit a
       security change there that the restored table would never see. Written under the role this run just took. */
    const sourceRunner = transactionRunner(deps.client, { fence: roleFence(request.source.table, fenced.epoch), table: request.source.table, now, sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), maxResends: 3 });
    const superseded: RestoreRecord = {
      restore_id: request.restoreId,
      state: "superseded",
      identity_table: request.source.table,
      peer_table: request.table,
      restore_point: request.restorePoint,
      started_at: now(),
      journal_digest: "0".repeat(64),
      journal_events: 0,
      completed_at: null,
      reviews: null,
    };
    try {
      await write(
        sourceRunner,
        {
          Put: {
            TableName: request.source.table,
            Item: restoreItem(superseded),
            ConditionExpression: "attribute_not_exists(#pk) OR #state <> :replaying",
            ExpressionAttributeNames: { "#pk": "pk", "#state": "state" },
            ExpressionAttributeValues: { ":replaying": { S: "replaying" } },
          },
        },
        "the source's superseded marker",
      );
    } catch (error) {
      return { kind: "incomplete", detail: `the source could not be marked superseded (${error instanceof Error ? error.message : String(error)}); nothing of the replay was written -- re-run`, report };
    }
    report = { ...report, source: { table: request.source.table, state: "fenced", role_epoch: fenced.epoch } };
  }

  /* 2. The target's role (an operator run: no routing or pool condition, and not the serving check). */
  let epoch: number;
  try {
    ({ epoch } = await takeOverIdentityWriter(deps.client, request.table, { task: request.by, pool: RESTORE_POOL, now, ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}) }));
  } catch (error) {
    if (error instanceof IdentityRoleRefusedError) return { kind: "incomplete", detail: `the restored table's identity-writer role could not be taken (${error.message})`, report };
    throw error;
  }
  report = { ...report, target_role_epoch: epoch };
  const runner = transactionRunner(deps.client, { fence: roleFence(request.table, epoch), table: request.table, now, sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), maxResends: 3 });

  /* 3-4. The marker (under the role) and the journal. */
  const readJournal = async (): Promise<SecurityEvent[]> => scanSecurityJournal(deps.ledger.client, deps.ledger.table, { segments: deps.scanSegments });
  const marker = await readIdentityRestore(deps.client, request.table); // again, under the role: what the CAS names
  if (completedHere(marker, request)) return { kind: "already-complete", report };
  const stopNow = targetMarkerProblem(marker, request);
  if (stopNow !== null) return { kind: "refused", detail: stopNow, report };
  let events: SecurityEvent[];
  try {
    events = await readJournal();
  } catch (error) {
    if (error instanceof SecurityJournalCorruptError) return { kind: "refused", detail: `the journal cannot be read without guessing: ${error.message}; nothing was written to the restored table`, report };
    throw error;
  }
  let plan: ReplayPlan;
  const startedAt = resumable(marker, request) ? marker.started_at : now();
  report = { ...report, started_at: startedAt };
  const replanWith = async (evts: readonly SecurityEvent[]): Promise<ReplayPlan> => {
    /* The plan against the table as it stands (strict; this restore's replaying marker required), with this restore's
       own review records (a resumed replay withdraws a review the journal no longer calls for). */
    const contents = await readIdentityTable(deps.client, request.table, deps.scanSegments);
    const mismatch = restoreLoadProblem(contents.restore, { id: request.restoreId }, request.table);
    if (mismatch !== null) throw new StoreDefiniteError(mismatch);
    return planSecurityReplay({ snapshot: contents.snapshot, events: evts, restoreId: request.restoreId, at: startedAt, ...reviewInputs(contents, request) });
  };
  /* The journal as a set (strict: a malformed or contradictory journal stops here, before the table is touched). */
  let digest: { readonly digest: string; readonly events: number };
  try {
    const canonical = canonicalJournal(events);
    digest = { digest: canonical.digest, events: canonical.events.length };
  } catch (error) {
    if (error instanceof SecurityReplayError) return { kind: "refused", detail: `the journal cannot be replayed without guessing: ${error.message}; nothing was written to the restored table`, report };
    throw error;
  }
  const replaying: RestoreRecord = {
    restore_id: request.restoreId,
    state: "replaying",
    identity_table: request.table,
    peer_table: request.source.table,
    restore_point: request.restorePoint,
    started_at: startedAt,
    journal_digest: digest.digest,
    journal_events: digest.events,
    completed_at: null,
    reviews: null,
  };
  const exactly = (read: RestoreRecord | null): { ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Item } =>
    read === null
      ? { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } }
      : {
          ConditionExpression: "#rid = :rid AND #state = :state AND #digest = :digest AND #table = :table",
          ExpressionAttributeNames: { "#rid": "restore_id", "#state": "state", "#digest": "journal_digest", "#table": "identity_table" },
          ExpressionAttributeValues: { ":rid": { S: read.restore_id }, ":state": { S: read.state }, ":digest": { S: read.journal_digest }, ":table": { S: read.identity_table } },
        };
  if (!resumable(marker, request) || marker.journal_digest !== digest.digest) {
    await write(runner, { Put: { TableName: request.table, Item: restoreItem(replaying), ...exactly(marker) } }, "the restore marker (replaying)");
  }
  report = { ...report, journal: digest };

  /* 5. The load and the plan. */
  try {
    plan = await replanWith(events);
  } catch (error) {
    if (error instanceof SecurityReplayError) return { kind: "refused", detail: `the journal cannot be replayed without guessing: ${error.message}; the table stays unserved`, report };
    if (error instanceof StoreDefiniteError) return { kind: "incomplete", detail: `${error.message}; re-run`, report };
    throw error;
  }
  report = { ...report, plan: plan.report, reviews: plan.reviews.map(summaryOf) };
  if (plan.journal.digest !== digest.digest) return { kind: "incomplete", detail: "the journal's digest moved between two reads of one run; re-run", report };

  /* 6. Per principal: its review record first, then its change. */
  const store = createDynamoIdentityStore(deps.client, request.table, { epoch, restore: { id: request.restoreId }, now, ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}), ...(deps.scanSegments !== undefined ? { scanSegments: deps.scanSegments } : {}) });
  await store.load();
  let applied = 0;
  for (const [at, entry] of plan.principals.entries()) {
    if (deps.stopAfter !== undefined && applied >= deps.stopAfter) return { kind: "incomplete", detail: `stopped after ${applied} principals (test interruption)`, report: { ...report, applied: { principals: applied, grants_removed: 0 } } };
    try {
      if (entry.review !== null) await write(runner, { Put: { TableName: request.table, Item: reviewItem(reviewRecordOf(entry.review, request.restoreId, startedAt)) } }, `the review record of replay #${at}`);
      if (entry.change !== null) await store.commit(entry.change);
      if (entry.dropReview !== null) {
        /* The replay withdraws its OWN review (after the profile is active again): only a record of this restore. */
        await write(
          runner,
          { Delete: { TableName: request.table, Key: keyAttributes(keys.review(entry.dropReview, request.restoreId)), ConditionExpression: "#rid = :rid", ExpressionAttributeNames: { "#rid": "restore_id" }, ExpressionAttributeValues: { ":rid": { S: request.restoreId } } } },
          `the withdrawal of replay #${at}'s review record`,
        );
      }
    } catch (error) {
      return { kind: "incomplete", detail: `replay #${at} of ${plan.principals.length} stopped (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}); the table stays unserved -- re-run to resume`, report: { ...report, applied: { principals: applied, grants_removed: 0 } } };
    }
    applied += 1;
  }
  const grants = await store.grants.live(0);
  if (grants.length > 0) await store.grants.remove(grants.map((grant) => grant.session_id));
  report = { ...report, applied: { principals: applied, grants_removed: grants.length } };

  /* 7. Verify: the same journal, nothing left to do, exactly the planned reviews. */
  let after: ReplayPlan;
  try {
    events = await readJournal();
    after = await replanWith(events);
  } catch (error) {
    return { kind: "incomplete", detail: `the verification could not plan (${error instanceof Error ? error.message : String(error)}); the table stays unserved`, report };
  }
  if (after.journal.digest !== digest.digest) return { kind: "incomplete", detail: "the journal CHANGED during the replay (a writer is still appending security events): stop every task, then re-run; the table stays unserved", report };
  const leftover = after.principals.filter((entry) => entry.change !== null || entry.dropReview !== null).length;
  if (leftover > 0) return { kind: "incomplete", detail: `the table still differs from the replay's target for ${leftover} principals after the replay; the table stays unserved -- re-run`, report };
  const stored = await readIdentityTable(deps.client, request.table, deps.scanSegments);
  const expected = new Map(after.reviews.map((review) => [review.profile_id, reviewRecordOf(review, request.restoreId, startedAt)] as const));
  const mine = stored.reviews.filter((review) => review.restore_id === request.restoreId);
  if (mine.length !== expected.size || !mine.every((review) => JSON.stringify(review) === JSON.stringify(expected.get(review.profile_id)))) {
    return { kind: "incomplete", detail: "the review records do not match the plan; the table stays unserved -- re-run", report };
  }
  if (stored.grants > 0) return { kind: "incomplete", detail: "sensitive-auth grant items remain; re-run", report };

  /* 8. Complete: only now may the table serve. */
  const current = stored.restore;
  if (current === null || current.restore_id !== request.restoreId || current.state !== "replaying" || current.journal_digest !== digest.digest) {
    return { kind: "incomplete", detail: "the restore marker is not this run's replaying marker any more; re-run", report };
  }
  try {
    /* One transaction: the marker complete AND the table naming itself (from now on a copy of it carries its name). */
    const outcome = await runner.run([
      { Put: { TableName: request.table, Item: restoreItem({ ...current, state: "complete", completed_at: now(), reviews: expected.size }), ...exactly(current) } },
      { Put: { TableName: request.table, Item: selfItem(request.table) } },
    ]);
    if (outcome.kind !== "committed") throw new Error(outcome.kind === "definite" ? (outcome.fenced ? "this run's role was taken over" : outcome.evaluated ? "its condition does not hold" : outcome.detail) : `the outcome is unknown (${outcome.detail})`);
  } catch (error) {
    return { kind: "incomplete", detail: `the restore could not be marked complete (${error instanceof Error ? error.message : String(error)}); re-run`, report };
  }
  return { kind: "complete", report };
}

/** Read only: the restore marker and every review record of a table (for the operator; ids and states only). */
export async function inspectIdentityRestore(client: DynamoDBClient, table: string, segments = 4): Promise<{ readonly marker: RestoreRecord | null; readonly reviews: readonly ReviewRecord[]; readonly role_epoch: number | null; readonly serving: boolean }> {
  const contents = await readIdentityTable(client, table, segments);
  return { marker: contents.restore, reviews: contents.reviews, role_epoch: contents.role?.epoch ?? null, serving: restoreLoadProblem(contents.restore, undefined, table, contents.self) === null };
}
