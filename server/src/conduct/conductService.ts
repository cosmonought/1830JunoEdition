// server/src/conduct/conductService.ts
//
// ==================================================================
//  PHASE 3 (P3-N035): RECEIVING A REPORT, AND A REVIEWER'S SMALL FACTUAL WORKFLOW
// ==================================================================
//
// RECEIVING (called by the room host, inside the game's own serving pool, after `roomAuthz` has said the caller holds a
// seat at this table -- `report` row): the reported seat must be ANOTHER seat of the same GameRecord; the category is
// from the closed list; the note passes the one sanitizer or the report is refused (never truncated). The case id is
// derived (`conductCaseId`): the same report again is the same case, answered "already received" -- whatever tab, retry
// or race sent it -- and costs nothing. Any other report spends one token of the reporter's own budget (per account: a
// burst, then a slow refill), taken before anything is hashed or written, so a flood from one account is refused while every other account's reports are untouched: there
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
//
// WHO IS A PARTY (consolidated final integration -- the cross-pool rule): the case's reporter and reported accounts,
// every principal seated at the table at any report (captured durably in the case itself, `table_principals`), AND the
// table's AUTHORITATIVE roster read from the durable GameRecord at the moment of review (`tableRosterOf`: its seats, its
// kicked principals and its creator -- read from the shared record store, never from this pool's in-memory index, so a
// game owned by ANOTHER pool, a restart, a pool handoff or a review answered by another host decide exactly the same).
// A roster that cannot be read is NOT "nobody": the case is withheld (queue), not shown (case) and not decided
// (decide) until it can be read -- fail closed.

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
  addReReport,
  CASE_ID_PATTERN,
  conductCaseId,
  ConductCaseUnreadableError,
  decideCase,
  deriveEvidence,
  isCaseParty,
  isQuietRepeat,
  lastReportAt,
  MAX_CASE_SEQUENCE,
  MAX_REPORTS_PER_SUBJECT,
  reportsIn,
  newConductCase,
  verifyLogPointer,
  type ConductCase,
  type ConductEvidence,
  type ConductParty,
  type ReReport,
} from "./conductCase";
import type { ConductCaseStore } from "./conductStore";
import type { ConductClockEvidence } from "./conductClockFacts";

/** A case whose table roster could not be read just now: it is not shown (fail closed) -- "try again", never "absent". */
export class ConductRosterUnavailableError extends Error {
  constructor(readonly caseId: string) {
    super(`the table roster of conduct case ${caseId} could not be read`);
    this.name = "ConductRosterUnavailableError";
  }
}

/** Per reporting account: three new reports at once, then one more every twenty minutes (a duplicate costs nothing). */
export const DEFAULT_REPORTER_BUDGET: BucketSpec = Object.freeze({ capacity: 3, refillPerSecond: 1 / 1200 });

export const REPORT_SENTENCES = Object.freeze({
  received: "Your report is with the operator for review, with the game's record as it is now. It does not change the game, any money or anyone's profile.",
  capped: "You have reported this player for this several times in this game, and the operator has those reports. Further reports about it in this game are not added. It does not change the game, any money or anyone's profile.",
  already: "You reported this player for this a moment ago, and nothing new has happened in the game since. That report is with the operator.",
  unconfirmed: "Your earlier report about this player could not be confirmed just now. Try again later.",
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
  /* "new": recorded (a new case or an addition to the open one -- never told apart, so a reporter cannot tell whether a
     reviewer has closed anything); "already": the same report a moment ago; "capped": this reporter's own reports about
     this have reached `MAX_REPORTS_PER_SUBJECT` (nothing new recorded in the case; the drop is audited). */
  | { readonly ok: true; readonly received: "new" | "already" | "capped"; readonly message: string }
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
  /** The table clock's facts (`conductClockFacts.ts`: the clock lane's own evidence, safely projected and bounded);
   *  `null` / absent: no clock record is known for the table. */
  readonly clock?: ConductClockEvidence | null;
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
  /** The table's AUTHORITATIVE roster now, read from the durable, shared GameRecord (every pool and host reads the same
   *  one): its seats, kicked principals and creator -- each a party to the table's cases. `null`: it could not be read
   *  now (the case is withheld: fail closed); `[]`: no record exists (the case's own captured principals decide).
   *  Absent (tests built without a record store): the case's own captured principals only. */
  readonly tableRosterOf?: (gameId: string) => Promise<readonly string[] | null>;
}

/* ---- the reviewer's views (never a principal id; parties as public seat ids, nicknames and fingerprints) ---- */

export interface ReviewParty {
  readonly playerId: string;
  readonly nickname: string;
  readonly account: string;
  /** When the seat was taken. */
  readonly joinedAt: number;
}

export interface CaseSummary {
  readonly caseId: string;
  readonly gameId: string;
  readonly category: ConductReportCategory;
  readonly categoryLabel: string;
  readonly createdAt: number;
  /** The latest report (the creation, or the reporter's latest addition). */
  readonly lastReportAt: number;
  /** How many reports the case holds (1 + the reporter's additions). */
  readonly reports: number;
  readonly status: ConductStatus;
  readonly statusLabel: string;
  readonly revision: number;
  readonly reporter: ReviewParty;
  readonly reported: ReviewParty;
  readonly hasNote: boolean;
}

export interface CaseView extends CaseSummary {
  readonly note: string | null;
  readonly evidence: ConductEvidence;
  readonly rereports: readonly ReReport[];
  readonly history: ReadonlyArray<{ readonly at: number; readonly from: ConductStatus; readonly to: ConductStatus; readonly note: string | null; readonly reviewer: string; readonly byYou: boolean }>;
  /** Other cases (any game, any reporter) naming the same reported account -- counted so a reviewer can tell one
   *  account's many reports from many accounts' reports: by how many distinct reporters and games, and their outcomes.
   *  `known` false: they could not be counted just now. Reviewers only. */
  readonly related: { readonly total: number; readonly active: number; readonly reporters: number; readonly games: number; readonly confirmed: number; readonly closedNoViolation: number; readonly known: boolean };
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

const party = (seat: { player_id: string; principal_id: string; nickname: string; joined_at: number }): ConductParty => ({
  player_id: seat.player_id,
  principal_id: seat.principal_id,
  nickname: String(seat.nickname).slice(0, 64),
  joined_at: Number.isSafeInteger(seat.joined_at) && seat.joined_at >= 0 ? seat.joined_at : 0,
});
const reviewParty = (value: ConductParty): ReviewParty => ({ playerId: value.player_id, nickname: value.nickname, account: accountFingerprint(value.principal_id), joinedAt: value.joined_at });

/** How long the reviewers' whole-store read is reused (queue, related counts): a burst of reviewer requests reads once. */
const READ_ALL_REUSE_MS = 5_000;
/** How many case loads run at once when the store is read whole. */
const LOAD_CONCURRENCY = 16;

export function createConductService(deps: ConductServiceDeps): ConductService {
  /* Per reporting ACCOUNT, in this process: a burst, then a slow refill. No shared or global budget exists, so one
     account's flood never refuses another account's report. (Per process: restarts and other pools start afresh --
     the residual is recorded in the report.) */
  const budget = new KeyedBuckets(deps.reporterBudget ?? DEFAULT_REPORTER_BUDGET, deps.now, 50_000);
  const store = deps.store;
  /** Whether the reviewer may handle the case: "party" -- its reporter, its reported account, anyone seated at its table
   *  when it was reported (or re-reported), or anyone on the table's durable roster NOW (seated, kicked, its creator);
   *  "unknown" -- the roster could not be read (withheld, fail closed); "clear" otherwise. A per-request `rosters` map
   *  reads each table once. */
  type Standing = "party" | "unknown" | "clear";
  async function standingOf(value: ConductCase, principalId: string, rosters: Map<string, Promise<readonly string[] | null>>): Promise<Standing> {
    if (isCaseParty(value, principalId)) return "party";
    if (deps.tableRosterOf === undefined) return "clear";
    let roster = rosters.get(value.game_id);
    if (roster === undefined) {
      const read = deps.tableRosterOf;
      roster = read(value.game_id).catch(() => null);
      rosters.set(value.game_id, roster);
    }
    const principals = await roster;
    if (principals === null) return "unknown";
    return principals.includes(principalId) ? "party" : "clear";
  }
  let cached: { readonly at: number; readonly value: Promise<{ readonly cases: ConductCase[]; readonly unreadable: number }> } | null = null;

  const summaryOf = (value: ConductCase): CaseSummary => ({
    caseId: value.case_id,
    gameId: value.game_id,
    category: value.category,
    categoryLabel: CONDUCT_CATEGORY_LABELS[value.category],
    createdAt: value.created_at,
    lastReportAt: lastReportAt(value),
    reports: 1 + value.rereports.length,
    status: value.status,
    statusLabel: CONDUCT_STATUS_LABELS[value.status],
    revision: value.revision,
    reporter: reviewParty(value.reporter),
    reported: reviewParty(value.reported),
    hasNote: value.note !== null || value.rereports.some((entry) => entry.note !== null),
  });

  async function readAllNow(): Promise<{ readonly cases: ConductCase[]; readonly unreadable: number }> {
    if (store === null) return { cases: [], unreadable: 0 };
    const ids = await store.list();
    const cases: ConductCase[] = [];
    let unreadable = 0;
    for (let at = 0; at < ids.length; at += LOAD_CONCURRENCY) {
      const loaded = await Promise.all(
        ids.slice(at, at + LOAD_CONCURRENCY).map(async (id) => {
          try {
            return await store.load(id);
          } catch (error) {
            if (error instanceof ConductCaseUnreadableError) return "unreadable" as const;
            throw error;
          }
        }),
      );
      for (const value of loaded) {
        if (value === "unreadable") unreadable += 1;
        else if (value !== null) cases.push(value);
      }
    }
    return { cases, unreadable };
  }

  /** The whole store, reused for a few seconds (and re-read at once after any write this process made). */
  function readAll(): Promise<{ readonly cases: ConductCase[]; readonly unreadable: number }> {
    const now = deps.now();
    if (cached !== null && now - cached.at < READ_ALL_REUSE_MS) return cached.value;
    const value = readAllNow();
    cached = { at: now, value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  }
  const forget = () => {
    cached = null;
  };

  async function viewOf(value: ConductCase, reviewerPrincipalId: string, readLog: (gameId: string) => Promise<readonly ServerLogEntry[] | null>): Promise<CaseView> {
    let verification: CaseView["verification"];
    try {
      const entries = await readLog(value.game_id);
      if (entries === null) verification = { verified: null, detail: "The game's log cannot be read on this server just now." };
      else {
        const first = verifyLogPointer(value.evidence, entries);
        const newest = [...value.rereports].reverse().find((entry) => entry.log.captured && entry.log.hash !== null);
        const last = newest === undefined ? null : verifyLogPointer({ ...value.evidence, log: { ...value.evidence.log, captured: true, entries: newest.log.entries, hash: newest.log.hash } }, entries);
        verification =
          last === null || first.verified === false
            ? first
            : last.verified === false
              ? { verified: false, detail: `The latest report's pointer: ${last.detail}` }
              : { verified: first.verified === null ? last.verified : first.verified && last.verified === true, detail: `${first.detail} The latest report's pointer: ${last.detail}` };
      }
    } catch (error) {
      deps.warn(`  conduct: re-verifying case ${value.case_id} failed -- ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      verification = { verified: null, detail: "The game's log could not be read just now." };
    }
    /* Best effort: a store that cannot be read whole just now never fails the view (or a decision already committed). */
    let related: CaseView["related"] = { total: 0, active: 0, reporters: 0, games: 0, confirmed: 0, closedNoViolation: 0, known: false };
    try {
      const reportedAccount = value.reported.principal_id;
      const others = (await readAll()).cases.filter((other) => other.case_id !== value.case_id && other.reported.principal_id === reportedAccount);
      related = {
        total: others.length,
        active: others.filter((other) => isConductCaseActive(other.status)).length,
        reporters: new Set(others.map((other) => other.reporter.principal_id)).size,
        games: new Set(others.map((other) => other.game_id)).size,
        confirmed: others.filter((other) => other.status === "conduct-confirmed").length,
        closedNoViolation: others.filter((other) => other.status === "no-violation").length,
        known: true,
      };
    } catch (error) {
      deps.warn(`  conduct: related cases of ${value.case_id} could not be counted -- ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    const mine = accountFingerprint(reviewerPrincipalId);
    return {
      ...summaryOf(value),
      note: value.note,
      evidence: value.evidence,
      rereports: value.rereports.map((entry) => ({ at: entry.at, note: entry.note, log: entry.log, counts: entry.counts, chat: entry.chat, clock: entry.clock ?? null })),
      history: value.history.map((event) => ({ ...event, byYou: event.reviewer === mine })),
      related,
      verification,
    };
  }

  /** Every case of one (game, reporter, reported account, category) sequence, in order, and the first free sequence
   *  number (`null`: none left). At most `MAX_CASE_SEQUENCE` reads; an unreadable case stops the report. */
  async function sequenceOf(
    gameId: string,
    reporterPrincipalId: string,
    reportedPrincipalId: string,
    category: ConductReportCategory,
  ): Promise<{ readonly kind: "read"; readonly cases: readonly ConductCase[]; readonly free: number | null } | { readonly kind: "unreadable" }> {
    const cases: ConductCase[] = [];
    for (let seq = 0; seq < MAX_CASE_SEQUENCE; seq += 1) {
      let value: ConductCase | null;
      try {
        value = await (store as ConductCaseStore).load(conductCaseId(gameId, reporterPrincipalId, reportedPrincipalId, category, seq));
      } catch (error) {
        if (error instanceof ConductCaseUnreadableError) return { kind: "unreadable" };
        throw error;
      }
      if (value === null) return { kind: "read", cases, free: seq };
      cases.push(value);
    }
    return { kind: "read", cases, free: null };
  }

  /** The most recently reported of `cases` (a later sequence number wins a tie). */
  const mostRecent = (cases: readonly ConductCase[]): ConductCase | null =>
    cases.reduce<ConductCase | null>((best, value) => (best === null || lastReportAt(value) >= lastReportAt(best) ? value : best), null);

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

      /* The sequence this report belongs to -- read before any budget is spent or any evidence is derived. */
      let sequence: Awaited<ReturnType<typeof sequenceOf>>;
      try {
        sequence = await sequenceOf(record.game_id, reporterSeat.principal_id, reportedSeat.principal_id, category);
      } catch (error) {
        deps.warn(`  conduct: could not read the cases of a report -- ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
        return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unavailable };
      }
      if (sequence.kind === "unreadable") {
        /* Honest to the reporter, and visible to the operator: a case of this sequence cannot be read. */
        deps.ops?.audit("conduct.report-unconfirmed", { game_id: record.game_id, category });
        return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unconfirmed };
      }
      const now = deps.now();
      const cases = sequence.cases;
      /* THE REPORTER LEARNS NOTHING ABOUT THE REVIEW. Every answer below depends only on this reporter's own reports and
         on the game they can see -- never on whether a reviewer has opened, closed or reopened a case:
           - "already": nothing has moved on (log, chat, time) since this reporter's latest report about this account and
             category -- judged against the most recent case of the sequence, whatever its status. Free.
           - otherwise ONE budget token is spent, before anything else is read, hashed or written (every recorded report
             and every capped one costs the same, so the budget cannot tell an open case from a closed one); it is given
             back only when nothing was written;
           - "capped": the reporter has already had `MAX_REPORTS_PER_SUBJECT` reports recorded about this (a count of
             their OWN reports); said plainly, and recorded in the operations audit so the operator sees reports kept
             coming;
           - "received": a new case, or an addition to the active one -- one sentence for both. */
      const latest = mostRecent(cases);
      const clockSeq = input.clock?.seq ?? null;
      if (latest !== null && isQuietRepeat(latest, input.entries.length, now, input.chat, clockSeq)) return { ok: true, received: "already", message: REPORT_SENTENCES.already };
      const wait = budget.take(reporterSeat.principal_id);
      if (wait > 0) return { ok: false, code: "rate-limited", reason: REPORT_SENTENCES.budget, retryAfterMs: wait };
      const recorded = cases.reduce((sum, value) => sum + reportsIn(value), 0);
      const capped = (): ReportAnswer => {
        deps.ops?.audit("conduct.report-capped", { case_id: (latest as ConductCase).case_id, game_id: record.game_id, category, reports: recorded });
        return { ok: true, received: "capped", message: REPORT_SENTENCES.capped };
      };
      if (recorded >= MAX_REPORTS_PER_SUBJECT) return capped();

      const active = mostRecent(cases.filter((value) => isConductCaseActive(value.status)));
      if (active !== null) {
        /* Something has moved on and a case is active: the report is ADDED to it. An addition the case cannot hold (its
           serialized bound) opens the next case of the sequence instead, below -- never a silent drop. */
        const probe = addReReport(active, {
          at: now,
          note: note.note,
          entries: input.entries,
          captured: input.unreadableHistory === undefined,
          chat: input.chat,
          seatPrincipals: record.seats.map((seat) => seat.principal_id),
          clock: input.clock ?? null,
        });
        if ("next" in probe) {
          const written = await store.save(probe.next, active.revision);
          if (written.kind === "committed") {
            forget();
            deps.ops?.audit("conduct.rereported", { case_id: active.case_id, game_id: record.game_id, category, reports: reportsIn(probe.next) });
            return { ok: true, received: "new", message: REPORT_SENTENCES.received };
          }
          budget.give(reporterSeat.principal_id);
          if (written.kind === "definite") {
            /* Most often the same report from another tab, landed a moment earlier (or a reviewer's decision): read the
               case again once, and if it now holds this same report, say so. */
            try {
              const now2 = await store.load(active.case_id);
              if (now2 !== null && isQuietRepeat(now2, input.entries.length, now, input.chat, clockSeq)) return { ok: true, received: "already", message: REPORT_SENTENCES.already };
            } catch {
              /* the refusal below stands */
            }
          }
          deps.warn(`  conduct: an addition to case ${active.case_id} was not saved (${written.kind}) -- ${written.detail.slice(0, 200)}`);
          return { ok: false, code: "unavailable", reason: written.kind === "uncertain" ? REPORT_SENTENCES.uncertain : REPORT_SENTENCES.notSaved };
        }
        if (probe.code === "quiet") {
          budget.give(reporterSeat.principal_id);
          return { ok: true, received: "already", message: REPORT_SENTENCES.already };
        }
      }
      /* Every case holds at least one report, so below the cap a free sequence number always remains. */
      if (sequence.free === null) return capped();
      const seq = sequence.free;

      const reporter = party(reporterSeat);
      const reported = party(reportedSeat);
      const evidence = deriveEvidence({ record, facts: input.facts, entries: input.entries, reporter, reported, chat: input.chat, money: input.money, clock: input.clock ?? null, build: deps.build, now, ...(input.unreadableHistory !== undefined ? { unreadableHistory: input.unreadableHistory } : {}) });
      const value = newConductCase({ record, category, reporter, reported, note: note.note, evidence, now, seq });
      const created = await store.create(value);
      if (created.outcome.kind === "committed" && created.existing === null && created.existingUnreadable !== true) {
        forget();
        deps.ops?.audit("conduct.reported", { case_id: value.case_id, game_id: record.game_id, category });
        return { ok: true, received: "new", message: REPORT_SENTENCES.received };
      }
      /* Not a new case: the token goes back (a race with another tab, or nothing was written). */
      budget.give(reporterSeat.principal_id);
      if (created.outcome.kind === "committed") return created.existingUnreadable === true ? { ok: false, code: "unavailable", reason: REPORT_SENTENCES.unconfirmed } : { ok: true, received: "already", message: REPORT_SENTENCES.already };
      deps.warn(`  conduct: case ${value.case_id} was not saved (${created.outcome.kind}) -- ${created.outcome.detail.slice(0, 200)}`);
      if (created.outcome.kind === "uncertain") return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.uncertain };
      return { ok: false, code: "unavailable", reason: REPORT_SENTENCES.notSaved };
    },

    async queue(reviewerPrincipalId) {
      const { cases, unreadable } = await readAll();
      /* A case the reviewer is a party to (reporter, reported, seated at its table at a report, or on its durable roster
         now) is not theirs to see; one whose roster cannot be read now is withheld and counted as not readable now. */
      const rosters = new Map<string, Promise<readonly string[] | null>>();
      const standings: Standing[] = [];
      for (let at = 0; at < cases.length; at += LOAD_CONCURRENCY) {
        standings.push(...(await Promise.all(cases.slice(at, at + LOAD_CONCURRENCY).map((value) => standingOf(value, reviewerPrincipalId, rosters)))));
      }
      const withheld = standings.filter((standing) => standing === "unknown").length;
      const ordered = cases.filter((_, i) => standings[i] === "clear").sort((left, right) => lastReportAt(right) - lastReportAt(left) || (left.case_id < right.case_id ? -1 : 1));
      return { cases: ordered.map((value) => summaryOf(value)), unreadable: unreadable + withheld };
    },

    async caseView(caseId, reviewerPrincipalId, readLog) {
      if (store === null || !CASE_ID_PATTERN.test(caseId)) return null;
      const value = await store.load(caseId); // an unreadable case rejects: the caller says so
      if (value === null) return null;
      /* A party is answered exactly as for a case that does not exist; so is a case whose table roster cannot be read
         now (fail closed: never shown to someone who may be a party). */
      const standing = await standingOf(value, reviewerPrincipalId, new Map());
      if (standing === "unknown") throw new ConductRosterUnavailableError(value.case_id);
      return standing === "clear" ? viewOf(value, reviewerPrincipalId, readLog) : null;
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
      /* A party -- who cannot see the case at all -- is answered as for a case that does not exist. */
      if (current === null) return { ok: false, code: "not-found", reason: "There is no such case." };
      const standing = await standingOf(current, input.reviewerPrincipalId, new Map());
      if (standing === "party") return { ok: false, code: "not-found", reason: "There is no such case." };
      if (standing === "unknown") return { ok: false, code: "unavailable", reason: "The case's table could not be checked just now. Try again in a moment." };
      const decided = decideCase(current, { expectedRevision: input.revision, to: input.status, note: note.note, reviewerPrincipalId: input.reviewerPrincipalId, now: deps.now() });
      if (!("next" in decided)) return { ok: false, code: decided.code, reason: decided.reason };
      const written: StoreWriteOutcome = await store.save(decided.next, current.revision);
      if (written.kind === "committed") {
        forget();
        deps.ops?.audit("conduct.reviewed", { case_id: current.case_id, from: current.status, to: decided.next.status, revision: decided.next.revision, reviewer: accountFingerprint(input.reviewerPrincipalId) });
        return { ok: true, view: await viewOf(decided.next, input.reviewerPrincipalId, readLog) };
      }
      if (written.kind === "uncertain") return { ok: false, code: "uncertain", reason: "The server could not confirm the decision was saved. Reload the case before deciding again." };
      return { ok: false, code: "stale", reason: "This case changed since you opened it (or could not be saved). Reload it and decide again." };
    },
  };
}
