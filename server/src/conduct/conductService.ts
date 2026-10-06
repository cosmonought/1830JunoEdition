// server/src/conduct/conductService.ts
//
// ==================================================================
//  PHASE 3 (P3-N032): RECEIVING A REPORT, AND A REVIEWER'S SMALL FACTUAL WORKFLOW
// ==================================================================
//
// RECEIVING (called by the room host, inside the game's own serving pool, after `roomAuthz` has said the caller holds a
// seat at this table -- `report` row): the reported seat must be ANOTHER seat of the same GameRecord; the category is
// from the closed list; the note passes the one sanitizer or the report is refused (never truncated). The case id is
// derived (`conductCaseId`): the same report again is the same case, answered "already received" -- whatever tab, retry
// or race sent it -- and costs nothing. A NEW case spends one token of the reporter's own budget (per account: a burst,
// then a slow refill), so a flood from one account is refused while every other account's reports are untouched: there
// is no shared, global budget an attacker could exhaust. The store's three outcomes are answered honestly: committed
// ("received"), definite ("not saved; try again"), uncertain ("could not confirm; a repeat is never counted twice").
//
// THE ANSWER SAYS NOTHING ELSE. A reporter learns "received" or "already received" -- never a case id, a status, a
// count, another player's reports or a reviewer's decision -- and the reported player learns nothing at all. Reports are
// not a channel between players.
//
// REVIEWING (called by `conductHttpApi.ts` for a configured reviewer only): list, read (with the log pointer re-verified
// against the authoritative log when the game can be read), and decide -- a transition from the small workflow
// (`conductReport.ts`), CONDITIONAL on the revision the reviewer read, with a bounded note, recorded in the case's own
// history under the reviewer's account fingerprint. A reviewer never decides a case they are a party to. A decision
// changes the case and nothing else: no game, seat, profile, trust fact, escrow or money is touched by any outcome.

import { KeyedBuckets, type BucketSpec } from "../ingress/limits";
import type { OpsRecorder } from "../persistence/opsRecorder";
import type { StoreWriteOutcome } from "../persistence/storeResult";
import { seatOf, type GameRecord, type LogFacts } from "../rooms/gameRecord";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { RoomChatEntry } from "../../../frontend/src/utils/roomProtocol";
import {
  checkConductNote,
  CONDUCT_CATEGORY_LABELS,
  CONDUCT_STATUS_LABELS,
  isConductCaseActive,
  isConductReportCategory,
  isConductStatus,
  MAX_REPORT_NOTE_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  type ConductReportCategory,
  type ConductStatus,
} from "../../../frontend/src/utils/conductReport";
import {
  accountFingerprint,
  CASE_ID_PATTERN,
  conductCaseId,
  ConductCaseUnreadableError,
  decideCase,
  deriveEvidence,
  newConductCase,
  verifyLogPointer,
  type ConductCase,
  type ConductEvidence,
  type ConductParty,
} from "./conductCase";
import type { ConductCaseStore } from "./conductStore";

/** Per reporting account: three new reports at once, then one more every twenty minutes (a duplicate costs nothing). */
export const DEFAULT_REPORTER_BUDGET: BucketSpec = Object.freeze({ capacity: 3, refillPerSecond: 1 / 1200 });

export const REPORT_SENTENCES = Object.freeze({
  received: "Your report was sent to the operator for review. It does not change the game, any money or anyone's profile.",
  already: "You have already reported this player for this at this table. Your earlier report stands; the reviewer sees the whole game's record.",
  self: "You cannot report yourself.",
  notAtTable: "That player is not at this table.",
  note: `Keep the note to a sentence or two (at most ${MAX_REPORT_NOTE_LENGTH} characters).`,
  category: "Choose what the report is about.",
  budget: "You have sent several reports recently. Wait a while before sending another.",
  unavailable: "Reports cannot be received on this server right now. Try again later.",
  notSaved: "The report could not be saved. Try again.",
  uncertain: "The server could not confirm the report was saved. Try again in a moment; a repeated report is never counted twice.",
});

export type ReportAnswer =
  | { readonly ok: true; readonly received: "new" | "already"; readonly message: string }
  | { readonly ok: false; readonly code: string; readonly reason: string; readonly retryAfterMs?: number };

export interface ReportInput {
  readonly record: Readonly<GameRecord>;
  readonly facts: LogFacts;
  readonly entries: readonly ServerLogEntry[];
  readonly reporterPrincipalId: string;
  readonly reportedPlayerId: unknown;
  readonly category: unknown;
  readonly note: unknown;
  /** The table's stored chat (`null`: could not be read). */
  readonly chat: readonly RoomChatEntry[] | null;
  /** A real-money table's financial standing (`null`: free table, or not readable). */
  readonly money: { readonly phase: string | null; readonly held: boolean } | null;
  /** A clock lane's snapshot, when one is wired (bounded in the evidence). */
  readonly clock?: unknown;
  /** Why the committed log could not be read into the report (a held or incompatible game), in words. */
  readonly unreadableHistory?: string;
}

export interface ConductServiceDeps {
  /** `null`: no durable store on this server -- reports are refused `unavailable`, never kept in memory only. */
  readonly store: ConductCaseStore | null;
  readonly build: string;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  readonly reporterBudget?: BucketSpec;
}

/* ---- the reviewer's views (never a principal id; parties as public seat ids, nicknames and fingerprints) ---- */

export interface ReviewParty {
  readonly playerId: string;
  readonly nickname: string;
  readonly account: string;
}

export interface CaseSummary {
  readonly caseId: string;
  readonly gameId: string;
  readonly category: ConductReportCategory;
  readonly categoryLabel: string;
  readonly createdAt: number;
  readonly status: ConductStatus;
  readonly statusLabel: string;
  readonly revision: number;
  readonly reporter: ReviewParty;
  readonly reported: ReviewParty;
  readonly hasNote: boolean;
  /** The reviewer asking is the reporter or the reported player: they may read it but not decide it. */
  readonly youAreParty: boolean;
}

export interface CaseView extends CaseSummary {
  readonly note: string | null;
  readonly evidence: ConductEvidence;
  readonly history: ReadonlyArray<{ readonly at: number; readonly from: ConductStatus; readonly to: ConductStatus; readonly note: string | null; readonly reviewer: string; readonly byYou: boolean }>;
  /** Other cases (any game, any reporter) naming the same reported account: how many, and how many still active. */
  readonly related: { readonly total: number; readonly active: number };
  /** The case's log pointer against the authoritative log now. */
  readonly verification: { readonly verified: boolean | null; readonly detail: string };
}

export type DecideAnswer =
  | { readonly ok: true; readonly view: CaseView }
  | { readonly ok: false; readonly code: "not-found" | "stale" | "wrong-state" | "party" | "history-full" | "bad-note" | "bad-status" | "unavailable" | "uncertain"; readonly reason: string };

export interface ConductService {
  readonly enabled: boolean;
  /** A seated player's report (the caller has already authorized the seat for this game). */
  report(input: ReportInput): Promise<ReportAnswer>;
  /** Every case, newest first (unreadable ones counted, never hidden). */
  queue(reviewerPrincipalId: string): Promise<{ readonly cases: readonly CaseSummary[]; readonly unreadable: number }>;
  caseView(caseId: string, reviewerPrincipalId: string, readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>): Promise<CaseView | null>;
  decide(
    input: { readonly caseId: unknown; readonly revision: unknown; readonly status: unknown; readonly note: unknown; readonly reviewerPrincipalId: string },
    readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>,
  ): Promise<DecideAnswer>;
}

const party = (seat: { player_id: string; principal_id: string; nickname: string }): ConductParty => ({ player_id: seat.player_id, principal_id: seat.principal_id, nickname: String(seat.nickname).slice(0, 64) });
const reviewParty = (value: ConductParty): ReviewParty => ({ playerId: value.player_id, nickname: value.nickname, account: accountFingerprint(value.principal_id) });

export function createConductService(deps: ConductServiceDeps): ConductService {
  const budget = new KeyedBuckets(deps.reporterBudget ?? DEFAULT_REPORTER_BUDGET, deps.now, 50_000);
  const store = deps.store;

  const summaryOf = (value: ConductCase, reviewerPrincipalId: string): CaseSummary => ({
    caseId: value.case_id,
    gameId: value.game_id,
    category: value.category,
    categoryLabel: CONDUCT_CATEGORY_LABELS[value.category],
    createdAt: value.created_at,
    status: value.status,
    statusLabel: CONDUCT_STATUS_LABELS[value.status],
    revision: value.revision,
    reporter: reviewParty(value.reporter),
    reported: reviewParty(value.reported),
    hasNote: value.note !== null,
    youAreParty: reviewerPrincipalId === value.reporter.principal_id || reviewerPrincipalId === value.reported.principal_id,
  });

  async function readAll(): Promise<{ readonly cases: ConductCase[]; readonly unreadable: number }> {
    if (store === null) return { cases: [], unreadable: 0 };
    const ids = await store.list();
    const cases: ConductCase[] = [];
    let unreadable = 0;
    for (const id of ids) {
      try {
        const value = await store.load(id);
        if (value !== null) cases.push(value);
      } catch (error) {
        if (error instanceof ConductCaseUnreadableError) unreadable += 1;
        else throw error;
      }
    }
    return { cases, unreadable };
  }

  async function viewOf(value: ConductCase, reviewerPrincipalId: string, readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>): Promise<CaseView> {
    let verification: CaseView["verification"];
    try {
      const entries = await readLog(value.game_id);
      verification = entries === null ? { verified: null, detail: "The game's log cannot be read on this server right now." } : verifyLogPointer(value.evidence, entries);
    } catch (error) {
      verification = { verified: null, detail: `The game's log could not be read: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}` };
    }
    const reportedAccount = value.reported.principal_id;
    let total = 0;
    let active = 0;
    for (const other of (await readAll()).cases) {
      if (other.case_id === value.case_id || other.reported.principal_id !== reportedAccount) continue;
      total += 1;
      if (isConductCaseActive(other.status)) active += 1;
    }
    return {
      ...summaryOf(value, reviewerPrincipalId),
      note: value.note,
      evidence: value.evidence,
      history: value.history.map((event) => ({ ...event, byYou: event.reviewer === accountFingerprint(reviewerPrincipalId) })),
      related: { total, active },
      verification,
    };
  }

  return {
    enabled: store !== null,

    async report(input): Promise<ReportAnswer> {
      if (store === null) return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unavailable };
      const record = input.record;
      const reporterSeat = seatOf(record as GameRecord, input.reporterPrincipalId);
      if (reporterSeat === null) return { ok: false, code: "not-seated", reason: "You do not have a seat in this game." };
      if (!isConductReportCategory(input.category)) return { ok: false, code: "bad-frame", reason: REPORT_SENTENCES.category };
      if (typeof input.reportedPlayerId !== "string") return { ok: false, code: "bad-frame", reason: REPORT_SENTENCES.notAtTable };
      if (input.reportedPlayerId === reporterSeat.player_id) return { ok: false, code: "forbidden", reason: REPORT_SENTENCES.self };
      const reportedSeat = record.seats.find((seat) => seat.player_id === input.reportedPlayerId) ?? null;
      if (reportedSeat === null) return { ok: false, code: "not-found", reason: REPORT_SENTENCES.notAtTable };
      if (reportedSeat.principal_id === reporterSeat.principal_id) return { ok: false, code: "forbidden", reason: REPORT_SENTENCES.self };
      const note = checkConductNote(input.note, MAX_REPORT_NOTE_LENGTH);
      if (!note.ok) return { ok: false, code: "bad-note", reason: REPORT_SENTENCES.note };
      const category = input.category;
      const caseId = conductCaseId(record.game_id, reporterSeat.principal_id, reportedSeat.player_id, category);

      /* The same report again is the same case: answered before any budget is spent or any evidence is derived. */
      try {
        if ((await store.load(caseId)) !== null) return { ok: true, received: "already", message: REPORT_SENTENCES.already };
      } catch (error) {
        if (error instanceof ConductCaseUnreadableError) return { ok: true, received: "already", message: REPORT_SENTENCES.already };
        deps.warn(`  conduct: could not read case ${caseId} -- ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
        return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unavailable };
      }

      const wait = budget.take(reporterSeat.principal_id);
      if (wait > 0) return { ok: false, code: "rate-limited", reason: REPORT_SENTENCES.budget, retryAfterMs: wait };

      const now = deps.now();
      const reporter = party(reporterSeat);
      const reported = party(reportedSeat);
      const evidence = deriveEvidence({ record, facts: input.facts, entries: input.entries, reporter, reported, chat: input.chat, money: input.money, clock: input.clock ?? null, build: deps.build, now, ...(input.unreadableHistory !== undefined ? { unreadableHistory: input.unreadableHistory } : {}) });
      const value = newConductCase({ record, category, reporter, reported, note: note.note, evidence, now });
      const created = await store.create(value);
      if (created.outcome.kind === "committed" && created.existing === null && created.existingUnreadable !== true) {
        deps.ops?.audit("conduct.reported", { case_id: caseId, game_id: record.game_id, category });
        return { ok: true, received: "new", message: REPORT_SENTENCES.received };
      }
      /* Not a new case: the token goes back (a race with another tab, or nothing was written). */
      budget.give(reporterSeat.principal_id);
      if (created.outcome.kind === "committed") return { ok: true, received: "already", message: REPORT_SENTENCES.already };
      deps.warn(`  conduct: case ${caseId} was not saved (${created.outcome.kind}) -- ${created.outcome.detail.slice(0, 200)}`);
      if (created.outcome.kind === "uncertain") return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.uncertain };
      return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.notSaved };
    },

    async queue(reviewerPrincipalId) {
      const { cases, unreadable } = await readAll();
      const ordered = cases.sort((left, right) => right.created_at - left.created_at || (left.case_id < right.case_id ? -1 : 1));
      return { cases: ordered.map((value) => summaryOf(value, reviewerPrincipalId)), unreadable };
    },

    async caseView(caseId, reviewerPrincipalId, readLog) {
      if (store === null || !CASE_ID_PATTERN.test(caseId)) return null;
      const value = await store.load(caseId); // an unreadable case rejects: the caller says so
      return value === null ? null : viewOf(value, reviewerPrincipalId, readLog);
    },

    async decide(input, readLog): Promise<DecideAnswer> {
      if (store === null) return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unavailable };
      if (typeof input.caseId !== "string" || !CASE_ID_PATTERN.test(input.caseId)) return { ok: false, code: "not-found", reason: "There is no such case." };
      if (!isConductStatus(input.status)) return { ok: false, code: "bad-status", reason: "That is not a review status." };
      if (!(typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision >= 1)) return { ok: false, code: "stale", reason: "Reload the case and decide again." };
      const note = checkConductNote(input.note, MAX_REVIEW_NOTE_LENGTH);
      if (!note.ok) return { ok: false, code: "bad-note", reason: `Keep the reviewer note to at most ${MAX_REVIEW_NOTE_LENGTH} characters.` };
      let current: ConductCase | null;
      try {
        current = await store.load(input.caseId);
      } catch (error) {
        if (error instanceof ConductCaseUnreadableError) return { ok: false, code: "unavailable", reason: "This case cannot be read; it is left exactly as stored for the operator." };
        throw error;
      }
      if (current === null) return { ok: false, code: "not-found", reason: "There is no such case." };
      const decided = decideCase(current, { expectedRevision: input.revision, to: input.status, note: note.note, reviewerPrincipalId: input.reviewerPrincipalId, now: deps.now() });
      if (!("next" in decided)) return { ok: false, code: decided.code, reason: decided.reason };
      const written: StoreWriteOutcome = await store.save(decided.next, current.revision);
      if (written.kind === "committed") {
        deps.ops?.audit("conduct.reviewed", { case_id: current.case_id, from: current.status, to: decided.next.status, revision: decided.next.revision });
        return { ok: true, view: await viewOf(decided.next, input.reviewerPrincipalId, readLog) };
      }
      if (written.kind === "uncertain") return { ok: false, code: "uncertain", reason: "The server could not confirm the decision was saved. Reload the case before deciding again." };
      return { ok: false, code: "stale", reason: "This case changed since you opened it (or could not be saved). Reload it and decide again." };
    },
  };
}
