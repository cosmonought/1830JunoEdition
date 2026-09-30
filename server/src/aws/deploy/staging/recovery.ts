// server/src/aws/deploy/staging/recovery.ts
//
// ==================================================================
//  LIVE-6 L6-6 (L6-4 ADDENDUM): THE RECOVERY GATES -- GENERATION, APPGEN BINDING, IDENTITY RESTORE, REVIEW#, ROLLBACK,
//  RESTORE QUIETNESS AND FENCING -- AS A CERTIFICATION CONTRACT OVER L6-4'S OWN READERS
// ==================================================================
//
// L6-4 (`088abbd`, Project `claude/LIVE6_L6_4_GENERATION_RESTORE_2026-09-30.md`) made the serving deployment depend on
// three more facts than L5-8 verifies: the game table's `SYSTEM/GENERATION`, APPGEN's adoption binding, and the identity
// table's restore state (`RESTORE#identity`, `TABLE#identity`, `REVIEW#`). This slice is built on L5-8 (`aa2c64c`) and does
// NOT merge L6-4. So the gates below are a CONTRACT:
//
//   - they judge L6-4's PARSED shapes (the interfaces are restated here, field for field: `GenerationMarker`,
//     `AppGeneration`/`Adoption`, `RestoreRecord`, `ReviewRecord`), never raw items -- the STRICT READING stays L6-4's
//     (`readGenerationMarker`, `readAppGeneration`, `readIdentityRestore`, `identityServingProblem`); this file builds no
//     competing parser;
//   - the readers arrive through `RecoveryReaders`, bound by the integration that contains both slices
//     (`tools/awsDeploy.ts`; the import guard's `aws/deploy` rule gains exactly those read functions). UNBOUND -- as on this
//     branch -- every gate below FAILS with "not integrated": the integrated deployment cannot PASS without them;
//   - missing, unreadable or mismatched evidence is FAIL, never SKIP.
//
// THE GATES:
//   generation     `SYSTEM/GENERATION` present and strictly readable; its generation = the runtime document's; it names the
//                  document's game_table; its bootstrap / restore form is internally valid; APPGEN = that generation; and
//                  the ADOPTION BINDS THIS TABLE (a bootstrap marker: APPGEN never adopted; a restore marker: APPGEN's
//                  adopted game_table and restore_id are the marker's, and its previous generation the marker's source).
//                  AND L6-4's OWN startup rule (`generationServingProblem`, bound to `generationMarkerProblem` +
//                  `adoptionBindingProblem`) accepts the same reading: the gate PASSES only when both agree, so it can
//                  never drift looser than the runtime it certifies (L6-6R).
//                  Read live by `stage-cert` (the bootstrap/verify role may GetItem SYSTEM/* and APPGEN).
//   identity       the identity table's restore state, classified and reported -- never-restored, target-complete,
//                  target-replaying (incomplete), source-superseded, unreplayed-copy, malformed -- and its TABLE#identity
//                  binding; only a serving-safe table (L6-4's `identityServingProblem` null, bound to its own name)
//                  passes. Read by the certifier task (the task role reads the identity table).
//   review         every OPEN `REVIEW#` record is an unresolved recovery finding: FAIL, surfaced by restore id and count
//                  only (never a profile, principal, selector, event id or hash). A summary without a boolean `open`, a
//                  restore id and a reason name makes the whole answer unreadable (FAIL), never "not open".
//   rollback       the deployment invariant (L6-4 §12.3) against ECS's REAL rollback rule (L6-6R): the deployment circuit
//                  breaker rolls a failed deployment back to the service's most recent COMPLETED deployment -- not to "any
//                  ACTIVE revision" (skip_destroy keeps every revision ACTIVE; none but that one is ever selected
//                  automatically). So for EVERY pool (not only the primary), the task definition of each COMPLETED
//                  deployment -- in a settled service, the running one -- must be an image attested to carry L6-4, bound
//                  by the IMAGE ECS ran (describe-tasks `imageDigest`, and the task definition's `image`), never by the
//                  BUILD_ID text: this run's certifier task (its own report of the L6-4 modules, from the primary's running
//                  definition), or an earlier PASSing certification of this environment copied into `prior-certifications/`.
//   restore-quiet  (scenario `restore-drill`) the stop before adoption: EVERY pool's service present and drained to zero,
//                  and no task in the cluster that is not STOPPED (the capture lists desired-RUNNING AND desired-STOPPED
//                  tasks: a task mid-shutdown is still running) -- captured for THIS run and THIS restore id, at most
//                  RESTORE_STOP_WINDOW_MS BEFORE APPGEN's `adopted_at`; with L6-5A integrated, no fresh `TASK#` heartbeat
//                  of an old-generation task after the stop -- operator proof, never a correctness lease.
//   restore-fence  (scenario `restore-drill`) the evidence slot for the later real-staging fencing probe: after THIS
//                  adoption (its restore id, table, generations and time), an old-generation ledger write refused BY THE
//                  GENERATION FENCE, an old-generation task never serving-ready for a GENERATION reason, the KMS side effect
//                  withheld with KMS never called, and the explicitly configured new generation serving-ready. No chain
//                  transaction or relayer sequence is needed and none is implied. No destructive or chain-affecting probe
//                  exists yet: the slot is judged, and missing evidence FAILS the drill.

import * as fs from "fs";
import * as path from "path";

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { Check } from "../deployVerify";
import { EVIDENCE_FILES, expectedNames } from "../deployVerify";
import { arr, CERTIFICATION_FORMAT, EVIDENCE, fail, judge, num, obj, readEvidence, str } from "./evidence";

/* ------------------------------------------------------------------ */
/* L6-4's parsed shapes (restated; the strict parsers are L6-4's)       */
/* ------------------------------------------------------------------ */

/** `aws/game/generationMarker.ts` `GenerationMarker` (L6-4). */
export interface GenerationMarkerFacts {
  readonly generation: number;
  readonly game_table: string;
  readonly origin: "bootstrap" | "restore";
  readonly restored_from_generation: number | null;
  readonly restored_from_table: string | null;
  readonly restore_point: number | null;
  readonly restore_id: string | null;
  readonly prepared_at: number;
  readonly prepared_by: string;
  readonly claim: string;
}

/** `aws/ledger/appGeneration.ts` `AppGeneration` (L6-4); `adoption` null: the bootstrap item, never adopted. */
export interface AppGenerationFacts {
  readonly current_generation: number;
  readonly adoption: { readonly previous_generation: number; readonly adopted_at: number; readonly adopted_by: string; readonly restore_id: string; readonly game_table: string; readonly claim: string } | null;
}

/** `aws/ledger/appGeneration.ts` `AdoptionRecord` (L6-4): `APPGEN#HISTORY / GEN#<generation>`, the adoption's own history
 *  item (its one transaction wrote it with APPGEN; the claim is that transaction's token). */
export interface AdoptionRecordFacts {
  readonly generation: number;
  readonly previous_generation: number;
  readonly adopted_at: number;
  readonly adopted_by: string;
  readonly restore_id: string;
  readonly game_table: string;
  readonly claim: string;
}

/** `aws/identity/identityItems.ts` `RestoreRecord` (L6-4). */
export interface IdentityRestoreFacts {
  readonly restore_id: string;
  readonly state: "replaying" | "complete" | "superseded";
  readonly identity_table: string;
  readonly peer_table: string;
  readonly restore_point: number;
  readonly started_at: number;
  readonly journal_digest: string;
  readonly journal_events: number;
  readonly completed_at: number | null;
  readonly reviews: number | null;
}

/** What a REVIEW# record may contribute to evidence: its restore, its reason, whether it is open. Nothing that names or
 *  keys a player (profile, principal), no selector, no event id, no hash. */
export interface ReviewSummary {
  readonly restore_id: string;
  readonly reason: string;
  readonly open: boolean;
}

/** A read that failed or found an item this build cannot read: its kind and a message (never item content). */
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly unreadable: string };

/**
 * L6-4's readers, bound by the integration (see the header) -- and ONLY there: the one production binding is
 * `tools/awsDeploy.ts`'s `StagingDeps.recovery`, and each member is L6-4's own function (or a projection of its answer),
 * never a re-implementation (a source guard in l6_6StagingCert.test.ts pins both). The exact binding:
 *
 *   generationMarker          readGenerationMarker                                   (aws/game/generationMarker.ts)
 *   appGeneration             readAppGeneration                                      (aws/ledger/appGeneration.ts)
 *   generationServingProblem  (m, a, e) => m === null || a === null || a.current_generation !== e.generation
 *                               ? generationMarkerProblem(m, e) ?? "APPGEN ..." : generationMarkerProblem(m, e) ??
 *                               adoptionBindingProblem(m, a.adoption)             -- the runtime's step 1, verbatim
 *   identityState             { restore: readIdentityRestore, self: TABLE#identity (decodeIdentityTable's `self`),
 *                               servingProblem: identityServingProblem }          (aws/identity/dynamoIdentityStore.ts)
 *   reviews                   inspectIdentityRestore(...).reviews.map(r => ({ restore_id: r.restore_id, reason: r.reason,
 *                               open: r.resolved_at === null }))                  (aws/identity/identityRestore.ts)
 *   adoptionRecord            readAdoptionRecord                                     (aws/ledger/appGeneration.ts)
 *                               -- LIVE-6 final convergence: the generation-gate record's `adoption_claim` is certified
 *                               against the ledger's own APPGEN#HISTORY/GEN#<new> (a plain JSON record is not integrity)
 *
 * BOUND (LIVE-6 final convergence, `live6/live-closure-candidate`): `tools/awsDeploy.ts` binds every member above.
 */
export interface RecoveryReaders {
  /** `readGenerationMarker` (null: no item; throws for an item it cannot read). */
  readonly generationMarker: (client: DynamoDBClient, gameTable: string) => Promise<GenerationMarkerFacts | null>;
  /** `readAppGeneration` (null: no APPGEN; throws for an item it cannot read). */
  readonly appGeneration: (client: DynamoDBClient, ledgerTable: string) => Promise<AppGenerationFacts | null>;
  /** L6-4's OWN startup rule over what was read (`awsRuntime.ts` step 1: APPGEN = the document, `generationMarkerProblem`,
   *  `adoptionBindingProblem`); null: a task configured for `expected` would start on this table. */
  readonly generationServingProblem: (marker: GenerationMarkerFacts | null, appgen: AppGenerationFacts | null, expected: { readonly generation: number; readonly gameTable: string }) => string | null;
  /** `readIdentityRestore`, the table's own name (TABLE#identity), and `identityServingProblem`. */
  readonly identityState: (client: DynamoDBClient, identityTable: string) => Promise<{ readonly restore: IdentityRestoreFacts | null; readonly self: string | null; readonly servingProblem: string | null }>;
  /** Every REVIEW# record, summarised (L6-4's strict decoder; the summary drops every identifying field). */
  readonly reviews: (client: DynamoDBClient, identityTable: string) => Promise<readonly ReviewSummary[]>;
  /** `readAdoptionRecord` (null: no adoption of that generation was ever made; throws for an item it cannot read). */
  readonly adoptionRecord: (client: DynamoDBClient, ledgerTable: string, generation: number) => Promise<AdoptionRecordFacts | null>;
}

export const NOT_INTEGRATED = "L6-4's readers are not bound in this build (the integration of L6-4 and L6-6 binds them): the gate cannot be certified";

/** Id-shaped material a reader's free text must never carry into evidence: player/session/recovery ids (L5-4's `pf_ pr_
 *  se_ sf_ rk_` + 26 base32), and long hex (event ids are 32 hex, key digests and journal digests 64). */
const ID_SHAPED = /(?<![0-9a-z])(?:pf|pr|se|sf|rk)_[0-9a-z]{26}(?![0-9a-z])|(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/g;
export const idShaped = (text: string): boolean => new RegExp(ID_SHAPED.source).test(text);
/** Reader-originated free text, made restore-safe: every id-shaped token replaced (never evidence). */
export const restoreSafe = (text: string): string => text.replace(ID_SHAPED, "<redacted>");

/* Redacted BEFORE it is cut: an id split at the cut would no longer look like one. */
const describeError = (error: unknown): string => restoreSafe(`${(error as { name?: string } | null)?.name ?? "Error"}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 240);

/** The shapes L6-4 gives its identifiers (`RESTORE_ID_PATTERN`, the table-name rule): a structured value outside them is
 *  not an identifier this contract names. (Restore ids and table names are never judged by `idShaped`: a restore id such as `drill-<git sha>`
 *  is L6-4-valid, and is only redacted where it is printed.) */
const RESTORE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

async function settle<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, unreadable: describeError(error) };
  }
}

/* ------------------------------------------------------------------ */
/* generation (live, stage-cert)                                        */
/* ------------------------------------------------------------------ */

export interface GenerationEvidence {
  readonly integrated: boolean;
  readonly marker: Read<GenerationMarkerFacts | null> | null;
  readonly appgen: Read<AppGenerationFacts | null> | null;
  /** L6-4's own startup rule over exactly what was read (null: not integrated). A throw is an unreadable answer. */
  readonly startupRule: ((expected: { readonly generation: number; readonly gameTable: string }) => Read<string | null>) | null;
  /** LIVE-6 final convergence: APPGEN#HISTORY/GEN#<APPGEN's current generation>, read only when APPGEN was read and is
   *  ADOPTED (absent / null: not read -- never adopted, or not integrated). */
  readonly history?: Read<AdoptionRecordFacts | null> | null;
}

export async function readGenerationEvidence(readers: RecoveryReaders | undefined, clients: { readonly app: DynamoDBClient; readonly ledger: DynamoDBClient }, tables: { readonly game: string; readonly ledger: string }): Promise<GenerationEvidence> {
  if (readers === undefined) return { integrated: false, marker: null, appgen: null, startupRule: null };
  const marker = await settle(() => readers.generationMarker(clients.app, tables.game));
  const appgen = await settle(() => readers.appGeneration(clients.ledger, tables.ledger));
  /* The adoption's own history item (one transaction wrote it with APPGEN): only for an adopted APPGEN. */
  const adopted = appgen.ok && appgen.value !== null && appgen.value.adoption !== null ? appgen.value.current_generation : null;
  const history = adopted === null ? null : await settle(() => readers.adoptionRecord(clients.ledger, tables.ledger, adopted));
  const startupRule = (expected: { readonly generation: number; readonly gameTable: string }): Read<string | null> => {
    if (!marker.ok || !appgen.ok) return { ok: false, unreadable: "the marker or APPGEN was not read" };
    try {
      const problem: unknown = readers.generationServingProblem(marker.value, appgen.value, expected);
      if (problem !== null && typeof problem !== "string") return { ok: false, unreadable: `L6-4's startup rule answered ${typeof problem}, not a problem or null` };
      return { ok: true, value: problem === null ? null : restoreSafe(problem) };
    } catch (error) {
      return { ok: false, unreadable: describeError(error) };
    }
  };
  return { integrated: true, marker, appgen, startupRule, history };
}

/** The marker's own form (L6-4's parser enforces it; restated so a reader bound wrongly cannot slip past the gate). */
export function markerFormProblem(m: GenerationMarkerFacts): string | null {
  const restoreFields = [m.restored_from_generation, m.restored_from_table, m.restore_point, m.restore_id];
  if (m.origin === "bootstrap") return restoreFields.every((f) => f === null) ? null : "a bootstrap marker names a restore";
  if (m.origin !== "restore") return `an unknown origin ${String(m.origin)}`;
  if (restoreFields.some((f) => f === null)) return "a restore marker without its source, point or restore id";
  if ((m.restored_from_generation ?? 0) >= m.generation) return "a restore marker whose source generation is not below its own";
  if (m.restored_from_table === m.game_table) return "a restore marker naming itself as its source";
  return null;
}

export function judgeGeneration(evidence: GenerationEvidence, expect: { readonly generation: number; readonly gameTable: string; readonly requireRestore: boolean }): Check[] {
  if (!evidence.integrated || evidence.marker === null || evidence.appgen === null || evidence.startupRule === null) return [fail("generation: SYSTEM/GENERATION and APPGEN", NOT_INTEGRATED)];
  const checks: Check[] = [];
  /* L6-4's own rule, over the same reading, for the same document: the composed checks below never PASS alone. */
  const rule = evidence.startupRule({ generation: expect.generation, gameTable: expect.gameTable });
  checks.push(judge("generation: L6-4's own startup rule accepts this table", rule.ok && rule.value === null, "generationMarkerProblem and adoptionBindingProblem: none", rule.ok ? `L6-4 refuses the start: ${String(rule.value)}` : `unreadable (${rule.unreadable})`));
  const m = evidence.marker;
  const a = evidence.appgen;
  if (!m.ok) checks.push(fail("generation: SYSTEM/GENERATION readable", `unreadable (${m.unreadable}): never read as some generation`));
  else if (m.value === null) checks.push(fail("generation: SYSTEM/GENERATION present", "the game table carries no SYSTEM/GENERATION (the bootstrap or a restore's preparation writes it)"));
  if (!a.ok) checks.push(fail("generation: APPGEN readable", `unreadable (${a.unreadable})`));
  else if (a.value === null) checks.push(fail("generation: APPGEN present", "the ledger has no APPGEN"));
  if (!m.ok || m.value === null || !a.ok || a.value === null) return checks;
  const marker = m.value;
  const appgen = a.value;
  const form = markerFormProblem(marker);
  checks.push(judge("generation: the marker's form", form === null, `${marker.origin} marker, internally valid`, String(form)));
  checks.push(judge("generation: the marker's generation = the runtime document's", marker.generation === expect.generation, `generation ${marker.generation}`, `the game table holds generation ${marker.generation}, the runtime document says ${expect.generation}`));
  checks.push(judge("generation: the marker names the configured game table", marker.game_table === expect.gameTable, marker.game_table, `the marker names ${marker.game_table}, the runtime document's game table is ${expect.gameTable}`));
  checks.push(judge("generation: APPGEN = the marker's generation", appgen.current_generation === marker.generation, `APPGEN current_generation ${appgen.current_generation}`, `APPGEN is ${appgen.current_generation}, the marker ${marker.generation} (not certified on the number alone: see the binding)`));
  const ad = appgen.adoption;
  let binding: string | null;
  if (marker.origin === "bootstrap") binding = ad === null ? null : `APPGEN adopted ${ad.game_table} (restore ${ad.restore_id}), but this table is a bootstrap table: not the adopted one`;
  else if (ad === null) binding = "this table is a prepared restore, but APPGEN was never adopted";
  else if (ad.game_table !== marker.game_table || ad.restore_id !== marker.restore_id) binding = `APPGEN adopted ${ad.game_table} (restore ${ad.restore_id}), not this table (${marker.game_table}, restore ${String(marker.restore_id)})`;
  else if (ad.previous_generation !== marker.restored_from_generation) binding = `APPGEN's previous generation ${ad.previous_generation} is not the marker's source generation ${String(marker.restored_from_generation)}`;
  else binding = null;
  checks.push(judge("generation: the adoption binds this table", binding === null, marker.origin === "bootstrap" ? "bootstrap table, APPGEN never adopted" : `APPGEN adopted ${marker.game_table} (restore ${String(marker.restore_id)}) from generation ${String(marker.restored_from_generation)}`, String(binding)));
  if (expect.requireRestore) checks.push(judge("generation: a restore drill serves the restored generation", marker.origin === "restore" && ad !== null, "restore marker, adopted", `a restore drill, but the serving table is a ${marker.origin} table${ad === null ? " and APPGEN was never adopted" : ""}`));
  return checks;
}

/** The record the certification keeps (no claim token: it is a write's token, and adds nothing to the audit). */
export function generationMeasurement(evidence: GenerationEvidence): Record<string, unknown> | null {
  if (!evidence.integrated || evidence.marker === null || evidence.appgen === null || evidence.startupRule === null) return null;
  const m = evidence.marker.ok ? evidence.marker.value : null;
  const a = evidence.appgen.ok ? evidence.appgen.value : null;
  return {
    marker: m === null ? null : { generation: m.generation, game_table: m.game_table, origin: m.origin, restored_from_generation: m.restored_from_generation, restored_from_table: m.restored_from_table, restore_id: m.restore_id },
    appgen: a === null ? null : { current_generation: a.current_generation, adopted: a.adoption === null ? null : { previous_generation: a.adoption.previous_generation, game_table: a.adoption.game_table, restore_id: a.adoption.restore_id, adopted_at: a.adoption.adopted_at } },
  };
}

/* ------------------------------------------------------------------ */
/* identity + review (the certifier task)                               */
/* ------------------------------------------------------------------ */

export type IdentityRestoreState = "never-restored" | "target-complete" | "target-replaying" | "source-superseded" | "unreplayed-copy" | "malformed";

/** The identity table's restore state, as the report names it (a diagnostic; the gate also requires L6-4's own
 *  `identityServingProblem` to be null). Anything this build does not name exactly is `malformed` -- never `complete`. */
export function identityRestoreState(restore: IdentityRestoreFacts | null, self: string | null, table: string): IdentityRestoreState {
  if (self !== null && typeof self !== "string") return "malformed";
  if (restore === null) return self !== null && self !== table ? "unreplayed-copy" : "never-restored";
  if (typeof restore !== "object" || typeof restore.identity_table !== "string" || typeof restore.restore_id !== "string") return "malformed";
  if (restore.identity_table !== table) return "unreplayed-copy";
  if (restore.state === "superseded") return "source-superseded";
  if (restore.state === "replaying") return "target-replaying";
  if (restore.state !== "complete") return "malformed";
  return self !== null && self !== table ? "unreplayed-copy" : "target-complete";
}

/** A REVIEW# summary as the contract names it -- a boolean `open`, a restore id, a reason name; anything else is a problem
 *  (never "not open"). Other fields are tolerated and never read: only `restore_id` and `reason` are projected. */
function reviewSummaryProblem(r: unknown): string | null {
  const o = obj(r);
  if (typeof o.open !== "boolean") return "a summary without a boolean `open`";
  if (typeof o.restore_id !== "string" || !RESTORE_ID.test(o.restore_id)) return "a summary whose restore id is not a restore id";
  if (typeof o.reason !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(o.reason) || idShaped(o.reason)) return "a summary whose reason is not a reason name";
  return null;
}

/** The task-role probe's `identity_state` section (read-only; ids and states only). */
export async function readIdentityRecovery(readers: RecoveryReaders | undefined, client: DynamoDBClient, identityTable: string): Promise<Record<string, unknown>> {
  if (readers === undefined) return { status: "not-integrated", reason: NOT_INTEGRATED };
  const state = await settle(() => readers.identityState(client, identityTable));
  const reviews = await settle(() => readers.reviews(client, identityTable));
  const restore = state.ok ? state.value.restore : null;
  /* Every string that came from a reader is made restore-safe; a structured id (restore, table) that looks like a player
     id or a hash is not an id this contract names: the state is then malformed (FAIL), and the value is not printed. */
  const safe = (v: unknown): string | null => (typeof v === "string" ? restoreSafe(v) : null);
  const unnamed =
    state.ok &&
    ((restore !== null && typeof restore === "object" && (typeof restore.restore_id !== "string" || !RESTORE_ID.test(restore.restore_id) || typeof restore.peer_table !== "string" || !TABLE_NAME.test(restore.peer_table))) ||
      (typeof state.value.self === "string" && !TABLE_NAME.test(state.value.self)));
  const reviewProblems = reviews.ok ? (Array.isArray(reviews.value) ? reviews.value.map(reviewSummaryProblem).filter((p): p is string => p !== null) : ["the answer is not a list"]) : [];
  return {
    status: "ran",
    identity_table: identityTable,
    state: state.ok
      ? {
          restore_state: unnamed ? "malformed" : identityRestoreState(restore, state.value.self, identityTable),
          restore_id: safe(restore?.restore_id),
          marker_state: safe(restore?.state),
          peer_table: safe(restore?.peer_table),
          table_binding: safe(state.value.self),
          /* L6-4's verdict: null only when it says null (an absent or non-string answer is never "no problem"). */
          serving_problem: state.value.servingProblem === null ? null : typeof state.value.servingProblem === "string" ? restoreSafe(state.value.servingProblem) : `not an answer (${typeof state.value.servingProblem})`,
          completed_at: typeof restore?.completed_at === "number" ? restore.completed_at : null,
        }
      : { unreadable: state.unreadable },
    reviews: !reviews.ok
      ? { unreadable: reviews.unreadable }
      : reviewProblems.length > 0
        ? { unreadable: `REVIEW# summaries malformed: ${[...new Set(reviewProblems)].join("; ")} (never counted as resolved)` }
        : { open: reviews.value.filter((r) => r.open === true).map((r) => ({ restore_id: restoreSafe(r.restore_id), reason: r.reason })), resolved: reviews.value.filter((r) => r.open === false).length },
  };
}

export function judgeIdentityRecovery(section: unknown, identityTable: string): Check[] {
  const s = obj(section);
  if (s.status !== "ran") return [fail("identity restore state", String(s.reason ?? "not recorded"))];
  const st = obj(s.state);
  if (typeof st.unreadable === "string") return [fail("identity restore state: readable", `unreadable (${st.unreadable})`)];
  const state = String(st.restore_state);
  const checks: Check[] = [
    judge("identity: the probed table is the configured one", s.identity_table === identityTable, identityTable, `probed ${String(s.identity_table)}, the runtime document names ${identityTable}`),
    judge(
      "identity: serving-safe restore state",
      (state === "never-restored" || state === "target-complete") && st.serving_problem === null,
      state === "target-complete" ? `target complete (restore ${String(st.restore_id)})` : "never restored",
      state === "target-replaying"
        ? `target replaying / incomplete (restore ${String(st.restore_id)}): it serves nothing -- never a healthy identity deployment`
        : state === "source-superseded"
          ? `source superseded by restore ${String(st.restore_id)} (replaced by ${String(st.peer_table)}): it never serves again`
          : state === "unreplayed-copy"
            ? "an unreplayed copy (it carries another table's name or restore marker): it serves nothing"
            : state === "malformed"
              ? "the restore state is not one this build names (malformed): it is never treated as serving-safe"
              : `not serving-safe: ${String(st.serving_problem)}`,
    ),
    judge("identity: TABLE#identity binding", st.table_binding === identityTable, `TABLE#identity names ${identityTable}`, st.table_binding === null ? "no TABLE#identity: no serving takeover has bound this table (a served deployment always has one)" : `TABLE#identity names ${String(st.table_binding)}, not ${identityTable}`),
  ];
  return checks;
}

export function judgeReviews(section: unknown): Check[] {
  const s = obj(section);
  if (s.status !== "ran") return [fail("REVIEW#", String(s.reason ?? "not recorded"))];
  const r = obj(s.reviews);
  if (typeof r.unreadable === "string") return [fail("REVIEW#: readable", `unreadable (${r.unreadable})`)];
  const open = arr(r.open).map(obj);
  const byRestore = new Map<string, number>();
  for (const o of open) byRestore.set(String(o.restore_id), (byRestore.get(String(o.restore_id)) ?? 0) + 1);
  return [
    judge(
      "REVIEW#: no unresolved recovery review",
      Array.isArray(r.open) && open.length === 0,
      `no open review (${String(num(r.resolved) ?? 0)} resolved)`,
      `${open.length} open REVIEW# record(s) -- an unresolved staging/recovery finding: ${[...byRestore].map(([id, n]) => `restore ${id}: ${n}`).join(", ")} (resolve through the operator path, L6-3)`,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/* rollback: the serving image and every automatic rollback target      */
/* ------------------------------------------------------------------ */

/** The L6-4 modules a build must carry (their compiled files, relative to this directory in dist/). */
export const L6_4_MODULES = Object.freeze({ generation_marker: "../../game/generationMarker.js", app_generation: "../../ledger/appGeneration.js", identity_restore: "../../identity/identityRestore.js", security_replay: "../../../identity/securityReplay.js" });

/** Which L6-4 modules THIS build carries -- evidence from the running image itself (no version number is invented). */
export function buildCapabilities(here: string = __dirname): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, file] of Object.entries(L6_4_MODULES)) out[name] = fs.existsSync(path.join(here, file));
  return out;
}

export const hasL64 = (capabilities: unknown): boolean => Object.keys(L6_4_MODULES).every((name) => obj(capabilities)[name] === true);

export const PRIOR_CERTIFICATIONS = "prior-certifications";
/** capture-evidence's list of every ACTIVE revision per pool. INFORMATIONAL since L6-6R: an ACTIVE revision is not an
 *  automatic rollback target (the circuit breaker selects the most recent COMPLETED deployment), so it is not judged. */
export const revisionsFile = (pool: string): string => `revisions-${pool}.json`;

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const gameServer = (containers: unknown): Record<string, unknown> | undefined => arr(containers).map(obj).find((c) => c.name === "game-server");

/** An image ECS ran, as ECS names it: the task definition's `image` reference and the digest describe-tasks resolved. */
export interface AttestedImage {
  readonly image: string;
  readonly digest: string;
  readonly by: string;
}

/**
 * The image THIS run's certifier task ran, and whether it is attested to carry L6-4: the task run-task started on the
 * primary's running definition (task-role-run.json, ECS's record), whose own record (the same task ARN, the service's
 * BUILD_ID) reports every L6-4 module present in its build. `image` is that definition's reference, `digest` the one ECS
 * resolved for the task. Nothing here is operator text.
 */
export function certifierImage(dir: string, expect: { readonly primaryPool: string; readonly primaryTaskDefinition: string | null; readonly primaryBuild: string | null; readonly runner: unknown }): { readonly image: string | null; readonly digest: string | null; readonly attested: boolean; readonly problem: string | null } {
  const run = readEvidence(dir, EVIDENCE.taskRoleRun);
  const td = readEvidence(dir, EVIDENCE_FILES.taskDefinition(expect.primaryPool));
  const task = run.ok ? arr(obj(run.value).tasks).map(obj)[0] : undefined;
  const image = td.ok ? str(gameServer(obj(obj(td.value).taskDefinition).containerDefinitions)?.image) : null;
  const digest = task === undefined ? null : str(gameServer(task.containers)?.imageDigest);
  const runner = obj(expect.runner);
  const problems = [
    !run.ok ? run.problem : task === undefined ? `${EVIDENCE.taskRoleRun} holds no task` : null,
    task !== undefined && (expect.primaryTaskDefinition === null || task.taskDefinitionArn !== expect.primaryTaskDefinition) ? `the certifier task ran ${String(task.taskDefinitionArn)}, not the primary's running ${String(expect.primaryTaskDefinition)}` : null,
    task !== undefined && (typeof runner.task_arn !== "string" || runner.task_arn !== task.taskArn) ? "the capability report is not the certifier task's own" : null,
    expect.primaryBuild === null || runner.build_id !== expect.primaryBuild ? `the report's BUILD_ID ${String(runner.build_id)} is not the service's ${String(expect.primaryBuild)}` : null,
    image === null ? `${EVIDENCE_FILES.taskDefinition(expect.primaryPool)} names no game-server image` : null,
    digest === null || !IMAGE_DIGEST.test(digest) ? "ECS reports no image digest for the certifier task's game-server container" : null,
    !hasL64(runner.build_capabilities) ? `the build reports ${JSON.stringify(runner.build_capabilities ?? null)} (the first AWS-mode image must contain L6-4)` : null,
  ].filter((p): p is string => p !== null);
  return { image, digest: digest !== null && IMAGE_DIGEST.test(digest) ? digest : null, attested: problems.length === 0, problem: problems.length === 0 ? null : problems.join("; ") };
}

/** Earlier certifications that attest an image: this environment's, this harness's format, PASS with no failed gate, the
 *  full L6-4 capability report, and the image + digest they certified. Anything else attests nothing (and is named). */
export function priorAttestations(dir: string, environment: string): { readonly images: AttestedImage[]; readonly ignored: string[] } {
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, PRIOR_CERTIFICATIONS)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  const images: AttestedImage[] = [];
  const ignored: string[] = [];
  for (const file of files) {
    const r = readEvidence(dir, path.join(PRIOR_CERTIFICATIONS, file), { ownRecord: true });
    if (!r.ok) {
      ignored.push(`${file}: ${r.problem}`);
      continue;
    }
    const c = obj(r.value);
    const why = [
      c.format === CERTIFICATION_FORMAT ? null : "not a certification",
      c.environment === environment ? null : `environment ${String(c.environment)}, not ${environment}`,
      c.verdict === "PASS" && Array.isArray(c.failed_gates) && c.failed_gates.length === 0 ? null : "not a PASS",
      hasL64(c.build_capabilities) ? null : "no L6-4 capability report",
      typeof c.image === "string" && c.image.length > 0 && typeof c.image_digest === "string" && IMAGE_DIGEST.test(c.image_digest) ? null : "no certified image and digest",
    ].filter((p): p is string => p !== null);
    if (why.length > 0) ignored.push(`${file}: ${why.join(", ")}`);
    else images.push({ image: String(c.image), digest: String(c.image_digest), by: `${file} (run ${String(c.run_id)})` });
  }
  return { images, ignored };
}

/**
 * The deployment invariant (L6-4 §12.3) against ECS's real rollback rule. For EVERY pool: its automatic rollback target --
 * the task definition of each COMPLETED deployment in services.json (in a settled service exactly one: the running one) --
 * must run an attested L6-4 image: the running tasks' digest (describe-tasks) and the definition's image reference equal
 * an attested image's. A pool whose service shows no COMPLETED deployment, a target whose image cannot be established, or
 * an image nothing attests: FAIL. Earlier ACTIVE revisions are NOT candidates (the circuit breaker never selects them).
 */
export function judgeRollback(
  dir: string,
  expect: {
    readonly environment: string;
    readonly pools: readonly string[];
    readonly primaryPool: string;
    readonly primaryBuild: string | null;
    readonly runningTaskDefinitions: Readonly<Record<string, string | null>>;
    readonly running: ReadonlyMap<string, readonly Record<string, unknown>[]>;
    readonly runner: unknown;
  },
): Check[] {
  const checks: Check[] = [];
  const own = certifierImage(dir, { primaryPool: expect.primaryPool, primaryTaskDefinition: expect.runningTaskDefinitions[expect.primaryPool] ?? null, primaryBuild: expect.primaryBuild, runner: expect.runner });
  checks.push(judge("rollback: the certified image contains L6-4", own.attested, `BUILD_ID ${String(expect.primaryBuild)}, ${String(own.image)} @ ${String(own.digest)}: carries ${Object.keys(L6_4_MODULES).join(", ")}`, String(own.problem)));
  const priors = priorAttestations(dir, expect.environment);
  const attested: AttestedImage[] = [...(own.attested && own.image !== null && own.digest !== null ? [{ image: own.image, digest: own.digest, by: "this run's certifier task" }] : []), ...priors.images];
  const services = readEvidence(dir, EVIDENCE_FILES.services);
  const names = expectedNames(expect.environment, 1);
  for (const pool of expect.pools) {
    const label = `rollback: ${pool} serves, and would roll back to, an L6-4 image`;
    if (!services.ok) {
      checks.push(fail(label, services.problem));
      continue;
    }
    const service = arr(obj(services.value).services).map(obj).find((s) => s.serviceName === names.service(pool));
    const deployments = arr(service?.deployments).map(obj);
    const targets = [...new Set(deployments.filter((d) => d.rolloutState === "COMPLETED").map((d) => String(d.taskDefinition)))];
    const runningTd = expect.runningTaskDefinitions[pool] ?? null;
    if (service === undefined || targets.length === 0) {
      checks.push(fail(label, service === undefined ? `${names.service(pool)} is not in ${EVIDENCE_FILES.services}` : "the service shows no COMPLETED deployment: its automatic rollback target cannot be named"));
      continue;
    }
    /* The running revision is judged too (in a settled service it IS the target; otherwise both must hold). */
    const candidates = [...new Set([...targets, ...(runningTd === null ? [] : [runningTd])])];
    const td = readEvidence(dir, EVIDENCE_FILES.taskDefinition(pool));
    const tdDoc = td.ok ? obj(obj(td.value).taskDefinition) : {};
    const problems: string[] = [];
    const proven: string[] = [];
    for (const arn of candidates) {
      const short = arn.split("/").pop();
      if (!td.ok || tdDoc.taskDefinitionArn !== arn) {
        problems.push(`${short}: its task definition was not captured (${td.ok ? `${EVIDENCE_FILES.taskDefinition(pool)} is ${String(tdDoc.taskDefinitionArn)}` : td.problem})`);
        continue;
      }
      const image = str(gameServer(tdDoc.containerDefinitions)?.image);
      const tasks = (expect.running.get(pool) ?? []).filter((t) => t.taskDefinitionArn === arn);
      const digests = tasks.map((t) => str(gameServer(t.containers)?.imageDigest));
      if (image === null) {
        problems.push(`${short}: names no game-server image`);
        continue;
      }
      if (digests.some((d) => d === null || !IMAGE_DIGEST.test(d))) {
        problems.push(`${short}: a running task shows no image digest`);
        continue;
      }
      if (digests.length === 0) {
        /* No running task (a pool at desired 0): ECS reports no digest, and a TAG is not evidence of content (an ECR
           IMMUTABLE tag can be deleted and pushed again). Only a reference pinned by digest establishes it. */
        const pinned = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? null;
        const by = pinned === null ? undefined : attested.find((a) => a.digest === pinned);
        if (by === undefined) problems.push(`${short}: ${image} (no running task) is not an attested L6-4 image${pinned === null ? " -- a tag is not evidence of content: run one task of the pool for the certification, or pin the image by digest" : ""}`);
        else proven.push(`${short} (${by.by}, pinned by digest)`);
        continue;
      }
      const by = attested.find((a) => a.image === image && digests.every((d) => d === a.digest));
      if (by === undefined) problems.push(`${short}: ${image} @ ${[...new Set(digests)].join(",")} is not an attested L6-4 image`);
      else proven.push(`${short} (${by.by})`);
    }
    const ignored = priors.ignored.length > 0 ? ` [prior certifications ignored: ${priors.ignored.join("; ")}]` : "";
    checks.push(judge(label, problems.length === 0 && proven.length > 0, `the COMPLETED deployment's ${proven.join(", ")}`, `${problems.join("; ")} -- certify that image, or roll the pool forward to one${ignored}`));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* restore drill: quietness and the fencing slot                        */
/* ------------------------------------------------------------------ */

export const RESTORE_STOP_DIR = "restore-stop";
export const RESTORE_STOP_FORMAT = "18COSMOS/L6-6-RESTORE-STOP/v2";
export const RESTORE_FENCING_FILE = "probe-restore-fencing.json";
export const RESTORE_FENCING_FORMAT = "18COSMOS/L6-6-RESTORE-FENCING/v1";
/** The stop is evidence of THIS adoption only when it was captured shortly before it (a stop, a restart, then an adoption
 *  hours later is not a quiet adoption). The drill's runbook stops, restores, prepares and adopts in one sitting. */
export const RESTORE_STOP_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Optional L6-5A seam: fresh TASK# heartbeats (operator proof only, never a lease). */
export interface HeartbeatEvidence {
  readonly integrated: boolean;
  /** Heartbeats seen after the stop, from tasks of the OLD generation (task ids only). */
  readonly oldGenerationAfterStop: readonly string[];
  /** LIVE-6 final convergence: why the heartbeats could not be read (an unreadable table is never "no heartbeat": FAIL). */
  readonly problem?: string;
}

/**
 * LIVE-6 final convergence: the TASK# reader the integration binds (`aws/runtime/taskHeartbeats.ts`
 * `oldGenerationHeartbeatsAfter`): the task ids of generation `generation` whose heartbeat in `table` (that generation's own
 * game table) was written after `after` (ms). Throws when the table cannot be read completely or an item decoded.
 */
export type TaskHeartbeatReader = (client: DynamoDBClient, table: string, expect: { readonly generation: number; readonly after: number }) => Promise<readonly string[]>;

/**
 * The restore drill's heartbeat evidence: the PREVIOUS generation's table (the adoption's `previous_generation`), fresh
 * after the restore-stop capture (`restore-stop/stamp.json` `captured_at`). Unbound reader: null (the gate then says the
 * stop is proven from ECS alone). No adoption, no stamp time, or a failed read: integrated, with the PROBLEM (FAIL).
 */
export async function readRestoreHeartbeats(reader: TaskHeartbeatReader | undefined, client: DynamoDBClient, input: { readonly dir: string; readonly adoption: AdoptionFacts | null; readonly tableOf: (generation: number) => string }): Promise<HeartbeatEvidence | null> {
  if (reader === undefined) return null;
  const ad = input.adoption;
  if (ad === null) return { integrated: true, oldGenerationAfterStop: [], problem: "APPGEN shows no adoption: the previous generation is not known" };
  const stamp = readEvidence(input.dir, path.join(RESTORE_STOP_DIR, "stamp.json"));
  const after = stamp.ok ? Date.parse(String(obj(stamp.value).captured_at)) : Number.NaN;
  if (!Number.isFinite(after)) return { integrated: true, oldGenerationAfterStop: [], problem: `no restore-stop time (${stamp.ok ? "restore-stop/stamp.json has no captured_at" : stamp.problem})` };
  try {
    const ids = await reader(client, input.tableOf(ad.previous_generation), { generation: ad.previous_generation, after });
    return { integrated: true, oldGenerationAfterStop: Array.isArray(ids) ? ids.map((t) => String(t)) : (ids as never) };
  } catch (error) {
    return { integrated: true, oldGenerationAfterStop: [], problem: `the old generation's TASK# items could not be read completely (${describeError(error)})` };
  }
}

/** APPGEN's adoption, as the drill gates bind to it (null: never adopted, or not read). */
export type AdoptionFacts = NonNullable<AppGenerationFacts["adoption"]> & { readonly generation: number };

export const adoptionOf = (evidence: GenerationEvidence): AdoptionFacts | null => {
  const a = evidence.appgen !== null && evidence.appgen.ok ? evidence.appgen.value : null;
  return a === null || a.adoption === null ? null : { ...a.adoption, generation: a.current_generation };
};

/**
 * The stop before adoption: `restore-stop/stamp.json` (format v2: the run, the restore id, the time),
 * `restore-stop/services.json` (EVERY pool's service present exactly once and ACTIVE, desired 0, running 0, pending 0; no
 * describe failure) and `restore-stop/cluster-tasks.json` (`{batches: [describe-tasks answer, ...]}`: every task the
 * cluster lists -- desired RUNNING and desired STOPPED -- is STOPPED; no describe failure in any batch) -- captured for THIS run and THIS adoption's restore id, before APPGEN's `adopted_at` and no more
 * than RESTORE_STOP_WINDOW_MS before it.
 */
export function judgeRestoreQuiet(dir: string, expect: { readonly run: string; readonly environment: string; readonly pools: readonly string[]; readonly adoption: AdoptionFacts | null; readonly heartbeats: HeartbeatEvidence | null }): Check[] {
  const services = readEvidence(dir, path.join(RESTORE_STOP_DIR, "services.json"));
  const tasks = readEvidence(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"));
  const stamp = readEvidence(dir, path.join(RESTORE_STOP_DIR, "stamp.json"));
  const missing = [services, tasks, stamp].filter((r) => !r.ok).map((r) => (r.ok ? "" : r.problem));
  if (missing.length > 0) return [fail("restore: the stop before adoption", `${missing.join("; ")} (capture the stopped state before appgen-adopt)`)];
  const s = obj(stamp.ok ? stamp.value : null);
  const at = Date.parse(String(s.captured_at));
  const servicesDoc = obj(services.ok ? services.value : null);
  const tasksDoc = obj(tasks.ok ? tasks.value : null);
  const names = expectedNames(expect.environment, 1);
  const listed = arr(servicesDoc.services).map(obj);
  /* Exactly one ACTIVE service per pool (a stale INACTIVE record of the same name is not the pool's service). */
  const absent = expect.pools.filter((pool) => listed.filter((x) => x.serviceName === names.service(pool) && x.status === "ACTIVE").length !== 1);
  const busy = listed.filter((x) => x.desiredCount !== 0 || x.runningCount !== 0 || x.pendingCount !== 0).map((x) => String(x.serviceName));
  /* The listing: one describe-tasks answer per batch of 100 (desired RUNNING and desired STOPPED), each whole. */
  const batches = Array.isArray(tasksDoc.batches) ? tasksDoc.batches.map(obj) : null;
  const allTasks = (batches ?? []).flatMap((b) => arr(b.tasks).map(obj));
  /* ECS task ids are ECS resource ids (32 hex), never player data: printed as they are, so the operator knows which task. */
  const live = allTasks.filter((t) => t.lastStatus !== "STOPPED").map((t) => String(String(t.taskArn).split("/").pop()));
  const complete = (doc: Record<string, unknown>) => Array.isArray(doc.failures) && doc.failures.length === 0;
  const listingWhole = batches !== null && batches.every((b) => Array.isArray(b.tasks) && complete(b));
  const ad = expect.adoption;
  const checks: Check[] = [
    judge(
      "restore: this run's and this restore's stop",
      s.format === RESTORE_STOP_FORMAT && s.run_id === expect.run && ad !== null && s.restore_id === ad.restore_id && Number.isFinite(at),
      `run ${expect.run}, restore ${String(s.restore_id)}, captured ${String(s.captured_at)}`,
      ad === null ? "APPGEN shows no adoption to bind the stop to" : `the stop evidence is ${String(s.format)} run ${String(s.run_id)} restore ${String(s.restore_id)} (this run ${expect.run}, APPGEN adopted restore ${ad.restore_id})`,
    ),
    judge(
      "restore: every pool stopped",
      absent.length === 0 && busy.length === 0 && expect.pools.length > 0 && complete(servicesDoc),
      `${expect.pools.join(", ")}: desired 0, running 0, pending 0`,
      absent.length > 0 ? `not in the stop evidence as exactly one ACTIVE service: ${absent.join(", ")}` : busy.length > 0 ? `not stopped: ${busy.join(", ")}` : "the service listing is incomplete (describe-services failures)",
    ),
    judge("restore: no task left in the cluster", listingWhole && live.length === 0, `every listed task STOPPED (${allTasks.length} listed, desired RUNNING and desired STOPPED)`, live.length > 0 ? `still running or stopping: ${live.join(", ")}` : "the task listing is incomplete (describe-tasks failures, or no batches)"),
    judge(
      "restore: the stop precedes the adoption",
      ad !== null && Number.isFinite(at) && at <= ad.adopted_at && ad.adopted_at - at <= RESTORE_STOP_WINDOW_MS,
      `stopped ${String(s.captured_at)}, adopted ${ad === null ? "?" : new Date(ad.adopted_at).toISOString()}`,
      ad === null ? "APPGEN shows no adoption" : Number.isFinite(at) && at > ad.adopted_at ? "the stop was captured after APPGEN moved" : `the stop was captured more than ${RESTORE_STOP_WINDOW_MS / 3_600_000} h before the adoption: it is not this adoption's stop`,
    ),
  ];
  if (expect.heartbeats !== null && expect.heartbeats.integrated) {
    const hb = Array.isArray(expect.heartbeats.oldGenerationAfterStop) ? expect.heartbeats.oldGenerationAfterStop : null;
    const problem = expect.heartbeats.problem;
    checks.push(
      judge(
        "restore: no old-generation TASK# heartbeat after the stop (operator proof, not a lease)",
        problem === undefined && hb !== null && hb.length === 0,
        "none (no heartbeat proves nothing: the stop is ECS's listing above)",
        problem !== undefined ? `unreadable: ${restoreSafe(problem)}` : hb === null ? "the heartbeat answer is not a list" : `fresh heartbeats from ${hb.map((t) => String(t)).join(", ")}`,
      ),
    );
  } else {
    /* Said in the report, never silently absent: the stop is proven from ECS alone until L6-5A's TASK# is integrated. A
       missing or stale TASK# never proves a task stopped: ECS's listing above is what proves it. */
    checks.push(judge("restore: TASK# heartbeats (operator proof, not a lease)", true, "not integrated (L6-5A): the stop is proven from ECS alone", ""));
  }
  return checks;
}

/**
 * The fencing probe's evidence slot (the probe itself is a later real-staging slice). The record
 * (`probe-restore-fencing.json`, format RESTORE_FENCING_FORMAT) names the run and the adoption it observed (restore id,
 * table, previous and new generation, adopted_at), and one case per RESTORE_FENCING_CASES, each observed AFTER adopted_at
 * with the structured result that proves GENERATION fencing -- never a bare "observed" or a generic process exit:
 *
 *   old-generation-ledger-write-refused  { generation: previous, outcome: "fenced", fence: "generation" }   (a disposable
 *                                          ledger write of the old generation, refused by APPGEN's ConditionCheck)
 *   old-generation-task-never-ready      { generation: previous, ready: false, exit_code: 2 | 3, reason: "generation" }
 *                                          (a task configured for the old generation: refused at startup or lost on its
 *                                          self-check BECAUSE the generation moved -- not any crash)
 *   kms-side-effect-withheld             { generation: previous, kms_sign_calls: 0, outcome: "withheld" }
 *   new-generation-started               { generation: new, game_table: the adopted table, ready: true }
 *
 * No case needs a chain transaction or a relayer sequence, and none implies a destructive action.
 */
export const RESTORE_FENCING_CASES = Object.freeze(["old-generation-ledger-write-refused", "old-generation-task-never-ready", "kms-side-effect-withheld", "new-generation-started"] as const);

function fencingCaseProblem(name: (typeof RESTORE_FENCING_CASES)[number], c: Record<string, unknown>, ad: AdoptionFacts): string | null {
  const when = Date.parse(String(c.observed_at));
  if (!Number.isFinite(when) || when < ad.adopted_at) return `observed ${String(c.observed_at)}, not after this adoption (${new Date(ad.adopted_at).toISOString()})`;
  const old = c.generation === ad.previous_generation;
  switch (name) {
    case "old-generation-ledger-write-refused":
      return old && c.outcome === "fenced" && c.fence === "generation" ? null : `generation ${String(c.generation)} (old: ${ad.previous_generation}), outcome ${String(c.outcome)}, fence ${String(c.fence)}: not a write of the old generation refused by the generation fence`;
    case "old-generation-task-never-ready":
      return old && c.ready === false && (c.exit_code === 2 || c.exit_code === 3) && c.reason === "generation" ? null : `generation ${String(c.generation)}, ready ${String(c.ready)}, exit ${String(c.exit_code)}, reason ${String(c.reason)}: a process exit is not generation fencing`;
    case "kms-side-effect-withheld":
      return old && c.kms_sign_calls === 0 && c.outcome === "withheld" ? null : `generation ${String(c.generation)}, KMS Sign calls ${String(c.kms_sign_calls)}, outcome ${String(c.outcome)}: not withheld before KMS`;
    case "new-generation-started":
      return c.generation === ad.generation && c.game_table === ad.game_table && c.ready === true ? null : `generation ${String(c.generation)} on ${String(c.game_table)}, ready ${String(c.ready)}: not the adopted generation ${ad.generation} on ${ad.game_table}`;
  }
  return "an unknown case";
}

export function judgeRestoreFencing(dir: string, expect: { readonly run: string; readonly adoption: AdoptionFacts | null }): Check[] {
  const r = readEvidence(dir, RESTORE_FENCING_FILE, { ownRecord: true });
  if (!r.ok) return [fail("restore fencing", `${r.problem} (the real-staging fencing probe records it; no destructive or chain-affecting probe is part of this slice)`)];
  const rec = obj(r.value);
  const cases = obj(rec.cases);
  const ad = expect.adoption;
  const observed = obj(rec.adoption);
  const same =
    ad !== null &&
    observed.restore_id === ad.restore_id &&
    observed.game_table === ad.game_table &&
    observed.previous_generation === ad.previous_generation &&
    observed.generation === ad.generation &&
    observed.adopted_at === ad.adopted_at;
  const checks: Check[] = [
    judge(
      "restore fencing: this run, this adoption",
      rec.format === RESTORE_FENCING_FORMAT && rec.run_id === expect.run && same,
      ad === null ? "" : `run ${expect.run}, restore ${ad.restore_id}: generation ${ad.previous_generation} -> ${ad.generation} (${ad.game_table})`,
      ad === null ? "APPGEN shows no adoption" : restoreSafe(`${String(rec.format)} run ${String(rec.run_id)}, adoption ${JSON.stringify(rec.adoption ?? null)} (APPGEN: restore ${ad.restore_id}, ${ad.previous_generation} -> ${ad.generation}, ${ad.game_table}, at ${ad.adopted_at})`),
    ),
  ];
  for (const name of RESTORE_FENCING_CASES) {
    const c = obj(cases[name]);
    const problem = cases[name] === undefined ? "no evidence recorded (probe missing)" : ad === null ? "APPGEN shows no adoption" : fencingCaseProblem(name, c, ad);
    checks.push(judge(`restore fencing: ${name}`, problem === null, restoreSafe(String(c.detail ?? "observed")), `NOT proven: ${restoreSafe(String(problem))}`));
  }
  return checks;
}
