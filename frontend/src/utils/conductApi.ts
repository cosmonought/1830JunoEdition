// frontend/src/utils/conductApi.ts
//
// PHASE 3 (P3-N035): CONDUCT REPORTS, CLIENT SIDE.
//
// REPORTING is a room op on the table's own socket (`room-op report-player`): `reportPlayerOp` builds its body, and the
// server answers only "received" or "already received" -- never a case id, a status or anything about other reports.
//
// REVIEWING is `/gs/api/conduct/*` for an account the server names as a reviewer. `conductRole` asks whether THIS
// account reviews (the profile menu shows the review entry only then); the review calls read the queue, one case and
// decide. Every answer is read strictly: parties are public seat ids, nicknames and account fingerprints, never an id
// or a username, and anything not exactly the expected shape is dropped rather than guessed at.

import { sessionPort, type SessionPort } from "./sessionBootstrap";
import type { RoomOpBody } from "./roomProtocol";
import { isConductReportCategory, isConductStatus, type ConductReportCategory, type ConductStatus } from "./conductReport";

/* ---- reporting ---- */

export type ReportPlayerBody = Extract<RoomOpBody, { type: "report-player" }>;

/** The room op for a report; an empty note is left out (the field is optional on the wire). */
export function reportPlayerOp(playerId: string, category: ConductReportCategory, note: string): ReportPlayerBody {
  const trimmed = note.trim();
  return { type: "report-player", playerId, category, ...(trimmed === "" ? {} : { note: trimmed }) };
}

/** What the server said to a report: received (new, already, or capped -- this reporter's own reports about it have
 *  reached the bound), or its refusal sentence. */
export type ReportOutcome = { readonly ok: true; readonly received: "new" | "already" | "capped"; readonly message: string } | { readonly ok: false; readonly code: string; readonly reason: string };

export function reportOutcomeOf(answer: { ok: true; data: Record<string, unknown> } | { ok: false; code: string; reason: string }): ReportOutcome {
  if (!answer.ok) return { ok: false, code: answer.code, reason: answer.reason };
  const received = answer.data.received;
  const message = typeof answer.data.message === "string" ? answer.data.message : "Your report was sent to the operator for review.";
  return { ok: true, received: received === "already" || received === "capped" ? received : "new", message };
}


/* ---- reviewing ---- */

export interface ReviewParty {
  readonly playerId: string;
  readonly nickname: string;
  readonly account: string;
  readonly joinedAt: number;
}

export interface CaseSummary {
  readonly caseId: string;
  readonly gameId: string;
  readonly category: ConductReportCategory;
  readonly categoryLabel: string;
  readonly createdAt: number;
  readonly lastReportAt: number;
  readonly reports: number;
  readonly status: ConductStatus;
  readonly statusLabel: string;
  readonly revision: number;
  readonly reporter: ReviewParty;
  readonly reported: ReviewParty;
  readonly hasNote: boolean;
}

export interface TimelineRow {
  readonly i: number;
  readonly at: number | null;
  readonly type: string;
  readonly by: "reporter" | "reported" | "other";
  readonly derived: boolean;
  readonly outcome?: "accepted" | "declined";
}

export interface OfferCounts {
  readonly offers: number;
  readonly accepted: number;
  readonly declined: number;
  readonly rescinded: number;
  readonly forgone: number;
  readonly undos: number;
  readonly passes: number;
  readonly actions: number;
}

export interface CaseEvidence {
  readonly capturedAt: number;
  readonly serverBuild: string;
  readonly rules: { readonly dealPin: number | null; readonly engine: number };
  readonly table: { readonly visibility: string; readonly status: string; readonly money: boolean; readonly seats: number };
  readonly log: { readonly captured: boolean; readonly entries: number; readonly hash: string | null; readonly windowFrom: number | null; readonly windowTo: number | null };
  readonly timeline: readonly TimelineRow[];
  readonly counts: { readonly reporter: OfferCounts; readonly reported: OfferCounts };
  readonly chat: ReadonlyArray<{ readonly id: string; readonly at: number; readonly by: "reporter" | "reported"; readonly text: string }> | null;
  readonly money: { readonly phase: string | null; readonly held: boolean } | null;
  readonly notCaptured: readonly string[];
}

export interface ReReportView {
  readonly at: number;
  readonly note: string | null;
  /** `captured: false`: the game's log could not be read into this addition (a held game) -- its counts are not zeros. */
  readonly log: { readonly captured: boolean; readonly entries: number; readonly hash: string | null };
  readonly counts: { readonly reporter: OfferCounts; readonly reported: OfferCounts };
  readonly chat: ReadonlyArray<{ readonly id: string; readonly at: number; readonly by: "reporter" | "reported"; readonly text: string }>;
}

export interface RelatedCases {
  readonly total: number;
  readonly active: number;
  readonly reporters: number;
  readonly games: number;
  readonly confirmed: number;
  readonly closedNoViolation: number;
  readonly known: boolean;
}

export interface CaseView extends CaseSummary {
  readonly note: string | null;
  readonly evidence: CaseEvidence;
  readonly rereports: readonly ReReportView[];
  readonly history: ReadonlyArray<{ readonly at: number; readonly from: ConductStatus; readonly to: ConductStatus; readonly note: string | null; readonly reviewer: string; readonly byYou: boolean }>;
  readonly related: RelatedCases;
  readonly verification: { readonly verified: boolean | null; readonly detail: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const int = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const str = (value: unknown, max = 600): value is string => typeof value === "string" && value.length <= max;

function partyOf(raw: unknown): ReviewParty | null {
  if (!isRecord(raw) || !str(raw.playerId, 40) || !str(raw.nickname, 64) || !str(raw.account, 24) || !/^acct-[0-9a-f]{12}$/.test(raw.account) || !int(raw.joinedAt)) return null;
  return { playerId: raw.playerId, nickname: raw.nickname, account: raw.account, joinedAt: raw.joinedAt };
}

export function caseSummaryOf(raw: unknown): CaseSummary | null {
  if (!isRecord(raw)) return null;
  const reporter = partyOf(raw.reporter);
  const reported = partyOf(raw.reported);
  if (reporter === null || reported === null) return null;
  if (!str(raw.caseId, 64) || !/^cc_[0-9a-f]{32}$/.test(raw.caseId) || !str(raw.gameId, 40) || !isConductReportCategory(raw.category) || !str(raw.categoryLabel, 80)) return null;
  if (!int(raw.createdAt) || !int(raw.lastReportAt) || !int(raw.reports) || !isConductStatus(raw.status) || !str(raw.statusLabel, 80) || !int(raw.revision) || typeof raw.hasNote !== "boolean") return null;
  return {
    caseId: raw.caseId,
    gameId: raw.gameId,
    category: raw.category,
    categoryLabel: raw.categoryLabel,
    createdAt: raw.createdAt,
    lastReportAt: raw.lastReportAt,
    reports: raw.reports,
    status: raw.status,
    statusLabel: raw.statusLabel,
    revision: raw.revision,
    reporter,
    reported,
    hasNote: raw.hasNote,
  };
}

function countsOf(raw: unknown): OfferCounts | null {
  if (!isRecord(raw)) return null;
  const keys = ["offers", "accepted", "declined", "rescinded", "forgone", "undos", "passes", "actions"] as const;
  if (!keys.every((key) => int(raw[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, raw[key] as number])) as unknown as OfferCounts;
}

function chatOf(raw: unknown): ReReportView["chat"] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((line): line is Record<string, unknown> => isRecord(line) && str(line.id, 64) && int(line.at) && (line.by === "reporter" || line.by === "reported") && str(line.text, 600))
    .map((line) => ({ id: line.id as string, at: line.at as number, by: line.by as "reporter" | "reported", text: line.text as string }));
}

const hashOf = (value: unknown): string | null => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null);

function reReportOf(raw: unknown): ReReportView | null {
  if (!isRecord(raw) || !int(raw.at) || !(raw.note === null || str(raw.note, 1000)) || !isRecord(raw.log) || !int(raw.log.entries) || !isRecord(raw.counts)) return null;
  const reporter = countsOf(raw.counts.reporter);
  const reported = countsOf(raw.counts.reported);
  if (reporter === null || reported === null) return null;
  return { at: raw.at, note: raw.note as string | null, log: { captured: raw.log.captured !== false, entries: raw.log.entries, hash: hashOf(raw.log.hash) }, counts: { reporter, reported }, chat: chatOf(raw.chat) };
}

function evidenceOf(raw: unknown): CaseEvidence | null {
  if (!isRecord(raw) || !isRecord(raw.rules) || !isRecord(raw.table) || !isRecord(raw.log) || !isRecord(raw.counts) || !Array.isArray(raw.timeline) || !Array.isArray(raw.not_captured)) return null;
  const reporter = countsOf(raw.counts.reporter);
  const reported = countsOf(raw.counts.reported);
  if (reporter === null || reported === null) return null;
  const timeline: TimelineRow[] = [];
  for (const row of raw.timeline) {
    if (!isRecord(row) || !int(row.i) || !(row.at === null || int(row.at)) || !str(row.type, 48) || !(row.by === "reporter" || row.by === "reported" || row.by === "other") || typeof row.derived !== "boolean") return null;
    timeline.push({ i: row.i, at: row.at as number | null, type: row.type, by: row.by, derived: row.derived, ...(row.outcome === "accepted" || row.outcome === "declined" ? { outcome: row.outcome } : {}) });
  }
  const chat: CaseEvidence["chat"] = isRecord(raw.chat) ? chatOf(raw.chat.lines) : null;
  const money = isRecord(raw.money) && (raw.money.phase === null || str(raw.money.phase, 32)) && typeof raw.money.held === "boolean" ? { phase: raw.money.phase as string | null, held: raw.money.held } : null;
  return {
    capturedAt: int(raw.captured_at) ? raw.captured_at : 0,
    serverBuild: str(raw.server_build, 64) ? raw.server_build : "",
    rules: { dealPin: int(raw.rules.deal_pin) ? raw.rules.deal_pin : null, engine: int(raw.rules.engine) ? raw.rules.engine : 0 },
    table: {
      visibility: str(raw.table.visibility, 16) ? raw.table.visibility : "",
      status: str(raw.table.status, 16) ? raw.table.status : "",
      money: raw.table.money === true,
      seats: int(raw.table.seats) ? raw.table.seats : 0,
    },
    log: {
      captured: raw.log.captured !== false,
      entries: int(raw.log.entries) ? raw.log.entries : 0,
      hash: hashOf(raw.log.hash),
      windowFrom: int(raw.log.window_from) ? raw.log.window_from : null,
      windowTo: int(raw.log.window_to) ? raw.log.window_to : null,
    },
    timeline,
    counts: { reporter, reported },
    chat,
    money,
    notCaptured: raw.not_captured.filter((line): line is string => str(line, 300)),
  };
}

export function caseViewOf(raw: unknown): CaseView | null {
  const summary = caseSummaryOf(raw);
  if (summary === null || !isRecord(raw)) return null;
  const evidence = evidenceOf(raw.evidence);
  if (evidence === null || !Array.isArray(raw.history) || !isRecord(raw.related) || !isRecord(raw.verification) || !Array.isArray(raw.rereports)) return null;
  const rereports: ReReportView[] = [];
  for (const entry of raw.rereports) {
    const parsed = reReportOf(entry);
    if (parsed === null) return null;
    rereports.push(parsed);
  }
  const history: CaseView["history"][number][] = [];
  for (const event of raw.history) {
    if (!isRecord(event) || !int(event.at) || !isConductStatus(event.from) || !isConductStatus(event.to) || !(event.note === null || str(event.note, 2000)) || !str(event.reviewer, 24) || typeof event.byYou !== "boolean") return null;
    history.push({ at: event.at, from: event.from, to: event.to, note: event.note as string | null, reviewer: event.reviewer, byYou: event.byYou });
  }
  const verified = raw.verification.verified;
  return {
    ...summary,
    note: raw.note === null || str(raw.note, 1000) ? (raw.note as string | null) : null,
    evidence,
    rereports,
    history,
    related: {
      total: int(raw.related.total) ? raw.related.total : 0,
      active: int(raw.related.active) ? raw.related.active : 0,
      reporters: int(raw.related.reporters) ? raw.related.reporters : 0,
      games: int(raw.related.games) ? raw.related.games : 0,
      confirmed: int(raw.related.confirmed) ? raw.related.confirmed : 0,
      closedNoViolation: int(raw.related.closedNoViolation) ? raw.related.closedNoViolation : 0,
      known: raw.related.known === true,
    },
    verification: { verified: verified === true || verified === false ? verified : null, detail: str(raw.verification.detail, 300) ? raw.verification.detail : "" },
  };
}

/** Whether this signed-in account may open the review panel (false on any doubt). */
export async function conductRole(port: SessionPort = sessionPort()): Promise<boolean> {
  const answer = await port.api("conduct/me", {});
  return answer.kind === "answered" && answer.status === 200 && answer.body?.reviewer === true;
}

export type ReviewAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string; readonly reason: string | null };

const failure = <T>(answer: Awaited<ReturnType<SessionPort["api"]>>): ReviewAnswer<T> => {
  if (answer.kind !== "answered") return { ok: false, error: "network", reason: null };
  const error = typeof answer.body?.error === "string" ? answer.body.error : `http-${answer.status}`;
  return { ok: false, error, reason: typeof answer.body?.reason === "string" ? answer.body.reason : null };
};

export async function reviewQueue(port: SessionPort = sessionPort()): Promise<ReviewAnswer<{ readonly cases: readonly CaseSummary[]; readonly unreadable: number }>> {
  const answer = await port.api("conduct/review/queue", {});
  if (answer.kind !== "answered" || answer.status !== 200 || !Array.isArray(answer.body?.cases)) return failure(answer);
  const cases = (answer.body?.cases as unknown[]).map(caseSummaryOf).filter((value): value is CaseSummary => value !== null);
  const unreadable = int(answer.body?.unreadable) ? (answer.body?.unreadable as number) : 0;
  return { ok: true, value: { cases, unreadable } };
}

export async function reviewCase(caseId: string, port: SessionPort = sessionPort()): Promise<ReviewAnswer<CaseView>> {
  const answer = await port.api("conduct/review/case", { caseId });
  const view = answer.kind === "answered" && answer.status === 200 ? caseViewOf(answer.body?.case) : null;
  return view === null ? failure(answer) : { ok: true, value: view };
}

export async function decideCase(input: { readonly caseId: string; readonly revision: number; readonly status: ConductStatus; readonly note: string }, port: SessionPort = sessionPort()): Promise<ReviewAnswer<CaseView>> {
  const note = input.note.trim();
  const answer = await port.api("conduct/review/decide", { caseId: input.caseId, revision: input.revision, status: input.status, note: note === "" ? null : note });
  const view = answer.kind === "answered" && answer.status === 200 ? caseViewOf(answer.body?.case) : null;
  return view === null ? failure(answer) : { ok: true, value: view };
}

/** The sentence a reviewer reads for a refused review call. */
export function reviewErrorSentence(error: string, reason: string | null): string {
  if (reason !== null && reason !== "") return reason;
  switch (error) {
    case "reauth-required":
      return "Confirm it's you to decide this case.";
    case "not-found":
      return "That case is not available to this account.";
    case "no-such-case":
      return "That case no longer exists.";
    case "case-unreadable":
      return "This case cannot be read; it is left as stored for the operator.";
    case "rate-limited":
      return "Too many requests too quickly. Wait a moment.";
    case "network":
      return "The server could not be reached. Try again.";
    default:
      return "The server could not do that just now. Try again.";
  }
}
