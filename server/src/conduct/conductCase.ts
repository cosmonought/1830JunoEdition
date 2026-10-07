// server/src/conduct/conductCase.ts
//
// ==================================================================
//  PHASE 3 (P3-N035): A CONDUCT REPORT'S DURABLE REVIEW CASE -- THE RECORD, ITS EVIDENCE, AND ITS REVIEW HISTORY
// ==================================================================
//
// A seated player may report another seat of the same table for conduct that may be legal but harmful to the game
// (stalling, abusive offers, harassment, suspected collusion, other). The report becomes ONE durable case for an
// operator's review. This file is pure: the case record, its strict validator, the deterministic case id, the evidence
// the SERVER derives from its own records at the moment of the report, and the reviewer's transitions.
//
// WHAT A CASE NEVER DOES. A case is a request to look, not a finding. Nothing in this directory writes a GameRecord, a
// log entry, a seat, a profile, an identity record, a trust fact, a financial record or any money; nothing reads a case
// to decide anything about play, money or a profile; and no case, count of cases or review outcome is ever projected to
// a player (`conductHttpApi.ts` answers reviewers only). A report that is never reviewed changes nothing.
//
// THE EVIDENCE IS THE SERVER'S. The reporter supplies a seat id (already public at the table), a category from a closed
// list and an optional short note. Everything else is derived server-side, inside the game's own serving pool, from the
// committed GameRecord and the committed log -- never from a client's claim:
//   - the table's identity and lifecycle, the deal's rules pin and this server's engine / build;
//   - both seats (public seat id and nickname; the principal is kept server-side and shown to reviewers only as a
//     stable account FINGERPRINT, never as an id);
//   - the committed log's length and its `logHash` at that length: the case POINTS AT the authoritative log rather
//     than copying it, and the pointer is BOUND -- a reviewer re-hashes the log's first `entries` entries and sees
//     whether the pointer still names exactly that history (logs are append-only: a later move never breaks it);
//   - a timeline of the most recent entries (index, server time, message type, which party acted -- no payload) and
//     whole-game counts of each party's offers, answers, rescissions, forgone offers, undos and passes: what a
//     reviewer needs to tell aggressive-but-legal negotiation from offers used to run down a timer. NOTHING here
//     infers motive from offer values; the counts are facts, the judgement is the reviewer's;
//   - the two parties' most recent stored chat lines (chat is already a server-kept record of the table, shown to its
//     seats; it is copied because its sidecar is lossy by design);
//   - a real-money table's financial phase and whether it is held (its dispute standing), when the money layer can say;
//   - what could NOT be captured in this build, said in words (no clock lane, no overdue / foreclosure events).
// No session id, cookie, recovery key or selector, password material, IP address, device data or wallet-proof material
// is ever read into a case.

import { createHash } from "crypto";

import { logHash } from "../../../frontend/src/gameEngine";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { RoomChatEntry } from "../../../frontend/src/utils/roomProtocol";
import {
  CONDUCT_STATUSES,
  conductTransitionAllowed,
  isConductReportCategory,
  isConductStatus,
  MAX_REPORT_NOTE_LENGTH,
  MAX_REVIEW_NOTE_LENGTH,
  type ConductReportCategory,
  type ConductStatus,
} from "../../../frontend/src/utils/conductReport";
import { effectiveStatus, GAME_ID_PATTERN, type GameRecord, type LogFacts } from "../rooms/gameRecord";

export const CONDUCT_CASE_FORMAT = "gs-conduct-case";
export const CONDUCT_CASE_VERSION = 1;
/** `cc_` + 32 lowercase hex: a digest (see `conductCaseId`), never a counter -- nothing about other cases is implied. */
export const CASE_ID_PATTERN = /^cc_[0-9a-f]{32}$/;
/** How many recent log entries the timeline carries (the whole log stays the authority; this is the reviewer's view). */
export const TIMELINE_LIMIT = 200;
/** How many of the two parties' most recent chat lines are copied. */
export const CHAT_LINES_LIMIT = 40;
/** How many review events one case keeps. A case at the limit takes no further decision: history is never dropped. */
export const MAX_REVIEW_EVENTS = 64;
/** How many times the same reporter may add to an ACTIVE case about the same account and category ("it is still
 *  happening"); each addition is charged to the reporter's budget and carries a fresh log pointer and counts. */
export const MAX_REREPORTS = 8;
/** How many reports ONE reporter may have recorded about one account in one category at one table, across every case
 *  of the sequence (the first report and every addition count; an "already received" repeat records nothing). The cap
 *  depends only on the reporter's own reports -- never on whether a reviewer has opened, closed or reopened anything --
 *  so reaching it tells the reporter nothing about the review. A report past it is answered so, charged like any other,
 *  and recorded in the operations audit (`conduct.report-capped`); the reports already kept stay with the operator. */
export const MAX_REPORTS_PER_SUBJECT = 1 + MAX_REREPORTS;
/** How many SUCCESSIVE cases one (game, reporter, reported account, category) may have: a report after the previous case
 *  was closed (or once the active one cannot take another addition) opens the next one, fresh evidence and all. Every
 *  case holds at least one report, so the sequence can never run out before `MAX_REPORTS_PER_SUBJECT` does. */
export const MAX_CASE_SEQUENCE = MAX_REPORTS_PER_SUBJECT;
/** A repeat of an active case is recorded only once the log has moved on, or this long after the last report. */
export const REREPORT_QUIET_MS = 10 * 60_000;
/** How many of the parties' chat lines a re-report copies (those newer than the case's last report). */
export const REREPORT_CHAT_LIMIT = 20;
/** How many seat principals a case keeps as parties (a table seats at most seven at once; seats change while it waits). */
export const MAX_TABLE_PRINCIPALS = 32;
/** A stored case's serialized bound (well inside a DynamoDB item and a file store's comfort). */
export const MAX_CASE_BYTES = 200 * 1024;
/** A lane's own clock evidence (`ConductReportInput.clock`) is kept only while its JSON stays this small. */
export const MAX_CLOCK_EVIDENCE_BYTES = 8 * 1024;

const PLAYER_ID = /^p-[0-9A-Za-z_-]{1,32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^acct-[0-9a-f]{12}$/;

/* ==================================================================
    THE RECORD
   ================================================================== */

export interface ConductParty {
  /** The seat's public id (already in every view of the table). */
  readonly player_id: string;
  /** SERVER-SIDE ONLY: the seat's controlling principal (immutable; LIVE-2 has no rebind). Never projected. */
  readonly principal_id: string;
  /** The seat's nickname when the report was made (presentation only). */
  readonly nickname: string;
  /** When this seat was taken (the GameRecord's `joined_at`): a reviewer sees a reporter who sat down a minute ago. */
  readonly joined_at: number;
}

export type TimelineParty = "reporter" | "reported" | "other";

export interface TimelineEntry {
  readonly i: number;
  readonly at: number | null;
  /** The gameplay message's type (its single key), or "?" for a payload this build could not read. */
  readonly type: string;
  readonly by: TimelineParty;
  readonly derived: boolean;
  /** An answer's outcome, when the entry is an answer to an offer. */
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

export interface ChatEvidenceLine {
  readonly id: string;
  readonly at: number;
  readonly by: "reporter" | "reported";
  readonly text: string;
}

export interface ConductEvidence {
  /** Always "server": no field of the evidence comes from the reporter's frame. */
  readonly source: "server";
  readonly captured_at: number;
  readonly server_build: string;
  readonly rules: { readonly deal_pin: number | null; readonly engine: number };
  readonly table: {
    readonly visibility: "public" | "private";
    readonly status: string;
    readonly money: boolean;
    readonly seats: number;
    readonly record_version: number;
    readonly created_at: number;
    readonly started_at: number | null;
    readonly completed_at: number | null;
    readonly closed_at: number | null;
    readonly last_activity_at: number;
  };
  /** The authoritative log, by reference: its first `entries` entries hash to `hash` (`logHash`). `captured` false: the
   *  log could not be read into the report (a held game serves no history) -- `entries: 0` then says nothing. */
  readonly log: { readonly captured: boolean; readonly entries: number; readonly hash: string | null; readonly window_from: number | null; readonly window_to: number | null };
  readonly timeline: readonly TimelineEntry[];
  readonly counts: { readonly reporter: OfferCounts; readonly reported: OfferCounts };
  /** `null`: no chat was available to read. */
  readonly chat: { readonly lines: readonly ChatEvidenceLine[] } | null;
  /** A real-money table's financial standing when the report was made (`null`: a free table, or not readable). */
  readonly money: { readonly phase: string | null; readonly held: boolean } | null;
  /** A clock lane's own snapshot when one is wired (JSON, bounded); `null` otherwise. */
  readonly clock: unknown;
  /** What this build could not capture, in words (so "absent" is never read as "nothing happened"). */
  readonly not_captured: readonly string[];
}

export interface ReviewEvent {
  readonly at: number;
  readonly from: ConductStatus;
  readonly to: ConductStatus;
  readonly note: string | null;
  /** The reviewer as an account fingerprint (never an id or a username). */
  readonly reviewer: string;
}

/** The same reporter, again, while the case is still active: "it is still happening" -- a fresh pointer into the log,
 *  both parties' whole-game counts as they are now, their chat since the last report, and the new note. */
export interface ReReport {
  readonly at: number;
  readonly note: string | null;
  /** `captured` false: the log could not be read then (a held game) -- the pointer and counts say nothing. */
  readonly log: { readonly captured: boolean; readonly entries: number; readonly hash: string | null };
  readonly counts: { readonly reporter: OfferCounts; readonly reported: OfferCounts };
  readonly chat: readonly ChatEvidenceLine[];
}

export interface ConductCase {
  readonly format: typeof CONDUCT_CASE_FORMAT;
  readonly version: typeof CONDUCT_CASE_VERSION;
  readonly case_id: string;
  /** Which successive case of its (game, reporter, reported account, category) this is: 0, then 1 once 0 was closed. */
  readonly seq: number;
  readonly game_id: string;
  readonly category: ConductReportCategory;
  readonly created_at: number;
  readonly reporter: ConductParty;
  readonly reported: ConductParty;
  /** SERVER-SIDE ONLY: every seat principal of the table when the report (or a re-report) was made. A reviewer seated at
   *  that table is a party to the case (a collusion partner must not judge it); the service also asks who sits there
   *  NOW. Never projected. */
  readonly table_principals: readonly string[];
  /** The reporter's note, sanitized (`checkConductNote`), or null. Shown to reviewers only. */
  readonly note: string | null;
  readonly evidence: ConductEvidence;
  /** The same reporter's later additions while the case was active (bounded). */
  readonly rereports: readonly ReReport[];
  /** CAS counter: 1 at creation, +1 per review decision and per re-report. */
  readonly revision: number;
  readonly status: ConductStatus;
  readonly history: readonly ReviewEvent[];
}

/* ==================================================================
    IDS AND FINGERPRINTS
   ================================================================== */

/**
 * The case id: one ACTIVE case per (game, reporting account, reported ACCOUNT, category), and at most
 * `MAX_CASE_SEQUENCE` successive ones. A second submission of the same report -- a double click, another tab, a retry
 * after a lost answer -- finds the case that stands instead of making another, so a report is never counted twice;
 * the same complaint again while the case is active is ADDED to it (`addReReport`); after the case was closed it opens
 * the next case in the sequence. Keyed by the reported principal (server-side), so leaving and retaking a waiting seat
 * (a new seat id) is the same account.
 */
export function conductCaseId(gameId: string, reporterPrincipalId: string, reportedPrincipalId: string, category: ConductReportCategory, seq: number): string {
  const digest = createHash("sha256").update(`18COSMOS/CONDUCT-CASE/v1\u0000${gameId}\u0000${reporterPrincipalId}\u0000${reportedPrincipalId}\u0000${category}\u0000${seq}`, "utf8").digest("hex");
  return `cc_${digest.slice(0, 32)}`;
}

/** A stable, non-reversible account label for reviewers: the same account shows the same fingerprint in every case. */
export function accountFingerprint(principalId: string): string {
  return `acct-${createHash("sha256").update(`18COSMOS/CONDUCT-ACCOUNT/v1\u0000${principalId}`, "utf8").digest("hex").slice(0, 12)}`;
}

/* ==================================================================
    THE EVIDENCE (derived, pure)
   ================================================================== */

const OFFER_TYPES = new Set(["ProposePrivatePurchase", "ProposeTrainPurchase", "ProposePrivateTrade", "OfferPrivateForFunding"]);
const ANSWER_TYPES = new Set(["AnswerPrivatePurchase", "AnswerTrainPurchase", "AnswerPrivateTrade", "AnswerFundingPrivateOffer"]);
const RESCIND_TYPES = new Set(["RescindPrivatePurchase", "RescindTrainPurchase", "RescindPrivateTrade", "RescindFundingPrivateOffer", "RescindTrainOffer"]);
const FORGO_TYPES = new Set(["ForgoTrainTrade", "ForgoPrivateFunding"]);
const UNDO_TYPES = new Set(["UndoLastAction", "RevertTo"]);
const PASS_TYPES = new Set(["PassTurn", "WaterfallPass", "WaterfallMiniAuctionPass"]);
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}$/;

/** A committed entry's message type and, for an answer, its outcome (the payload is JSON text: `{ <Type>: {...} }`). */
export function entryKind(entry: Pick<ServerLogEntry, "payload">): { readonly type: string; readonly outcome?: "accepted" | "declined" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.payload);
  } catch {
    return { type: "?" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { type: "?" };
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || !TYPE_NAME.test(keys[0])) return { type: "?" };
  const type = keys[0];
  if (type === "AcceptTrainOffer") return { type, outcome: "accepted" };
  if (type === "RejectTrainOffer") return { type, outcome: "declined" };
  if (ANSWER_TYPES.has(type)) {
    const body = (parsed as Record<string, unknown>)[type];
    const accept = typeof body === "object" && body !== null ? (body as Record<string, unknown>).accept : undefined;
    if (accept === true) return { type, outcome: "accepted" };
    if (accept === false) return { type, outcome: "declined" };
  }
  return { type };
}

export const emptyCounts = (): { -readonly [K in keyof OfferCounts]: number } => ({ offers: 0, accepted: 0, declined: 0, rescinded: 0, forgone: 0, undos: 0, passes: 0, actions: 0 });

function tally(counts: { -readonly [K in keyof OfferCounts]: number }, kind: { type: string; outcome?: "accepted" | "declined" }, derived: boolean): void {
  if (derived) return; // the server's own consequences are not a player's action
  counts.actions += 1;
  if (OFFER_TYPES.has(kind.type)) counts.offers += 1;
  else if (kind.outcome === "accepted") counts.accepted += 1;
  else if (kind.outcome === "declined") counts.declined += 1;
  else if (RESCIND_TYPES.has(kind.type)) counts.rescinded += 1;
  else if (FORGO_TYPES.has(kind.type)) counts.forgone += 1;
  else if (UNDO_TYPES.has(kind.type)) counts.undos += 1;
  else if (PASS_TYPES.has(kind.type)) counts.passes += 1;
}

export interface EvidenceInput {
  readonly record: Readonly<GameRecord>;
  readonly facts: LogFacts;
  readonly entries: readonly ServerLogEntry[];
  readonly reporter: ConductParty;
  readonly reported: ConductParty;
  readonly chat: readonly RoomChatEntry[] | null;
  readonly money: { readonly phase: string | null; readonly held: boolean } | null;
  readonly clock: unknown;
  readonly build: string;
  readonly now: number;
  /** Why the committed log could not be read (a held game serves no history), in words; recorded as not captured. */
  readonly unreadableHistory?: string;
}

/** Both parties' whole-game counts (a player's own actions; the server's derived consequences are not counted). */
export function partyCounts(entries: readonly ServerLogEntry[], reporterPlayerId: string, reportedPlayerId: string): { reporter: OfferCounts; reported: OfferCounts } {
  const counts = { reporter: emptyCounts(), reported: emptyCounts() };
  for (const entry of entries) {
    const party = entry.actor === reporterPlayerId ? "reporter" : entry.actor === reportedPlayerId ? "reported" : null;
    if (party !== null) tally(counts[party], entryKind(entry), entry.derived === true);
  }
  return counts;
}

/** The committed log's hash at its full length (`null` for an empty log, or one two entries of which claim an index). */
export function logPointerOf(entries: readonly ServerLogEntry[]): { readonly entries: number; readonly hash: string | null } {
  const ordered = [...entries].sort((left, right) => left.index - right.index);
  if (ordered.length === 0) return { entries: 0, hash: null };
  try {
    return { entries: ordered.length, hash: logHash(ordered) };
  } catch {
    return { entries: ordered.length, hash: null };
  }
}

/** The two parties' chat lines, as evidence (newest last, bounded). */
export function partyChat(chat: readonly RoomChatEntry[], reporter: Pick<ConductParty, "player_id">, reported: Pick<ConductParty, "player_id">, limit: number, after = -1): ChatEvidenceLine[] {
  return chat
    .filter((line) => (line.author === reporter.player_id || line.author === reported.player_id) && typeof line.at === "number" && line.at > after)
    .slice(-limit)
    .map((line) => ({ id: String(line.id).slice(0, 64), at: line.at, by: line.author === reporter.player_id ? ("reporter" as const) : ("reported" as const), text: String(line.text).slice(0, 600) }));
}

/** What the server captures for a case, from its own records only. */
export function deriveEvidence(input: EvidenceInput): ConductEvidence {
  const { record, entries, reporter, reported } = input;
  const ordered = [...entries].sort((left, right) => left.index - right.index);
  const partyOf = (actor: string): TimelineParty => (actor === reporter.player_id ? "reporter" : actor === reported.player_id ? "reported" : "other");
  const counts = partyCounts(ordered, reporter.player_id, reported.player_id);
  const window = ordered.slice(-TIMELINE_LIMIT);
  const timeline: TimelineEntry[] = window.map((entry) => {
    const kind = entryKind(entry);
    return {
      i: entry.index,
      at: typeof entry.at === "number" && Number.isSafeInteger(entry.at) ? entry.at : null,
      type: kind.type,
      by: partyOf(entry.actor),
      derived: entry.derived === true,
      ...(kind.outcome !== undefined ? { outcome: kind.outcome } : {}),
    };
  });
  let hash: string | null = null;
  try {
    hash = ordered.length === 0 ? null : logHash(ordered);
  } catch {
    hash = null; // two entries claiming one index: the pointer is left unbound and the reviewer is told
  }
  const chat = input.chat === null ? null : { lines: partyChat(input.chat, reporter, reported, CHAT_LINES_LIMIT) };
  let clock: unknown = null;
  if (input.clock !== null && input.clock !== undefined) {
    try {
      const text = JSON.stringify(input.clock);
      clock = text !== undefined && Buffer.byteLength(text, "utf8") <= MAX_CLOCK_EVIDENCE_BYTES ? JSON.parse(text) : { omitted: "the clock snapshot was larger than the evidence bound" };
    } catch {
      clock = { omitted: "the clock snapshot could not be serialized" };
    }
  }
  const notCaptured: string[] = [];
  if (input.unreadableHistory !== undefined) notCaptured.push(input.unreadableHistory.slice(0, 300));
  if (clock === null) notCaptured.push("Clock and turn-responsibility transitions: this server keeps no gameplay clock record for this table.");
  notCaptured.push("Overdue and foreclosure events: this build has no such events.");
  if (input.chat === null) notCaptured.push("Chat: the table's stored chat could not be read when the report was made.");
  if (record.money !== null && input.money === null) notCaptured.push("Money: the table's financial record could not be read when the report was made.");
  if (hash === null && ordered.length > 0) notCaptured.push("Log hash: the committed log could not be hashed (two entries claim one index).");
  return {
    source: "server",
    captured_at: input.now,
    server_build: input.build.slice(0, 64),
    rules: { deal_pin: record.rules_engine_version, engine: RULES_ENGINE_VERSION },
    table: {
      visibility: record.visibility,
      status: effectiveStatus(record as GameRecord, input.facts, input.now),
      money: record.money !== null,
      seats: record.seats.length,
      record_version: record.record_version,
      created_at: record.created_at,
      started_at: record.started_at,
      completed_at: record.completed_at,
      closed_at: record.closed_at,
      last_activity_at: record.last_activity_at,
    },
    log: { captured: input.unreadableHistory === undefined, entries: ordered.length, hash, window_from: window.length > 0 ? window[0].index : null, window_to: window.length > 0 ? window[window.length - 1].index : null },
    timeline,
    counts,
    chat,
    money: record.money === null ? null : input.money,
    clock,
    not_captured: notCaptured,
  };
}

/** Does the authoritative log still begin with exactly the history the case points at? (`null`: cannot be judged.) */
export function verifyLogPointer(evidence: ConductEvidence, entries: readonly ServerLogEntry[]): { readonly verified: boolean | null; readonly detail: string } {
  if (!evidence.log.captured) return { verified: null, detail: "The report could not read the game's log (see what was not captured)." };
  if (evidence.log.entries === 0) return { verified: null, detail: "The game had no log entries when the report was made." };
  if (evidence.log.hash === null) return { verified: null, detail: "The case carries no log hash (see what was not captured)." };
  if (entries.length < evidence.log.entries) return { verified: false, detail: `The log now holds ${entries.length} entries, fewer than the ${evidence.log.entries} the report saw.` };
  let now: string;
  try {
    now = logHash(entries, evidence.log.entries);
  } catch {
    return { verified: false, detail: "The log could not be hashed (two entries claim one index)." };
  }
  return now === evidence.log.hash
    ? { verified: true, detail: `The log's first ${evidence.log.entries} entries still hash to the value the report recorded.` }
    : { verified: false, detail: `The log's first ${evidence.log.entries} entries no longer hash to the value the report recorded.` };
}

/* ==================================================================
    MAKING A CASE
   ================================================================== */

export function newConductCase(input: {
  readonly record: Readonly<GameRecord>;
  readonly category: ConductReportCategory;
  readonly reporter: ConductParty;
  readonly reported: ConductParty;
  readonly note: string | null;
  readonly evidence: ConductEvidence;
  readonly now: number;
  readonly seq?: number;
}): ConductCase {
  const seq = input.seq ?? 0;
  return {
    format: CONDUCT_CASE_FORMAT,
    version: CONDUCT_CASE_VERSION,
    case_id: conductCaseId(input.record.game_id, input.reporter.principal_id, input.reported.principal_id, input.category, seq),
    seq,
    game_id: input.record.game_id,
    category: input.category,
    created_at: input.now,
    reporter: input.reporter,
    reported: input.reported,
    table_principals: [...new Set(input.record.seats.map((seat) => seat.principal_id))].slice(0, MAX_TABLE_PRINCIPALS),
    note: input.note,
    evidence: input.evidence,
    rereports: [],
    revision: 1,
    status: "open",
    history: [],
  };
}

/** The time of the case's latest report (its creation, or its latest re-report). */
export const lastReportAt = (value: ConductCase): number => (value.rereports.length === 0 ? value.created_at : value.rereports[value.rereports.length - 1].at);
/** The log length the case's latest report saw. */
export const lastReportEntries = (value: ConductCase): number => (value.rereports.length === 0 ? value.evidence.log.entries : value.rereports[value.rereports.length - 1].log.entries);

/** Whether `principalId` is a party to the case: the reporter, the reported account, or anyone seated at that table. */
export const isCaseParty = (value: ConductCase, principalId: string): boolean =>
  principalId === value.reporter.principal_id || principalId === value.reported.principal_id || value.table_principals.includes(principalId);

/** How many reports a case holds (its first, and every addition). */
export const reportsIn = (value: ConductCase): number => 1 + value.rereports.length;

/** Whether either party has said anything in the table's chat since the case's latest report (harassment is mostly
 *  chat, which never lengthens the game log). `null` chat (not readable): nothing is known to be new. */
export const partyChattedSince = (value: ConductCase, chat: readonly RoomChatEntry[] | null): boolean =>
  chat !== null && chat.some((line) => (line.author === value.reporter.player_id || line.author === value.reported.player_id) && typeof line.at === "number" && line.at > lastReportAt(value));

/** Whether a repeat of the latest report is the SAME report (nothing has moved on): the log is no longer, neither party
 *  has chatted since, and the quiet window has not passed. Judged against the latest case of the sequence, whatever its
 *  status. */
export const isQuietRepeat = (latest: ConductCase, entries: number, at: number, chat: readonly RoomChatEntry[] | null = null): boolean =>
  entries <= lastReportEntries(latest) && at - lastReportAt(latest) < REREPORT_QUIET_MS && !partyChattedSince(latest, chat);

/** The same reporter adds to an ACTIVE case (the caller has checked it is active and charged the budget). The case's
 *  serialized bound is kept: the addition's chat is trimmed to fit, and an addition that cannot fit is `full`. */
export function addReReport(
  current: ConductCase,
  input: { readonly at: number; readonly note: string | null; readonly entries: readonly ServerLogEntry[]; readonly captured: boolean; readonly chat: readonly RoomChatEntry[] | null; readonly seatPrincipals: readonly string[] },
): { readonly next: ConductCase } | { readonly code: "full" | "quiet" } {
  if (current.rereports.length >= MAX_REREPORTS) return { code: "full" };
  const pointer = logPointerOf(input.entries);
  if (isQuietRepeat(current, pointer.entries, input.at, input.chat)) return { code: "quiet" };
  const counts = partyCounts([...input.entries].sort((left, right) => left.index - right.index), current.reporter.player_id, current.reported.player_id);
  let chat = input.chat === null ? [] : partyChat(input.chat, current.reporter, current.reported, REREPORT_CHAT_LIMIT, lastReportAt(current));
  const principals = [...new Set([...current.table_principals, ...input.seatPrincipals])].slice(0, MAX_TABLE_PRINCIPALS);
  for (;;) {
    const rereport: ReReport = { at: input.at, note: input.note, log: { captured: input.captured, ...pointer }, counts, chat };
    const next: ConductCase = { ...current, table_principals: principals, revision: current.revision + 1, rereports: [...current.rereports, rereport] };
    if (serializeConductCase(next) !== null) return { next };
    if (chat.length === 0) return { code: "full" };
    chat = chat.slice(Math.ceil(chat.length / 2));
  }
}

export type DecisionRefusal =
  | { readonly code: "stale"; readonly reason: string }
  | { readonly code: "wrong-state"; readonly reason: string }
  | { readonly code: "party"; readonly reason: string }
  | { readonly code: "history-full"; readonly reason: string };

/** The next case after a reviewer's decision, or why it is refused. Pure: the store's CAS decides the race. */
export function decideCase(current: ConductCase, input: { readonly expectedRevision: number; readonly to: ConductStatus; readonly note: string | null; readonly reviewerPrincipalId: string; readonly now: number }): { readonly next: ConductCase } | DecisionRefusal {
  if (current.revision !== input.expectedRevision) return { code: "stale", reason: "This case changed since you opened it. Reload it and decide again." };
  if (isCaseParty(current, input.reviewerPrincipalId)) {
    return { code: "party", reason: "You are a party to this case (or were seated at its table), so another reviewer must decide it." };
  }
  if (!conductTransitionAllowed(current.status, input.to)) return { code: "wrong-state", reason: "That status cannot follow the case's current status." };
  if (current.history.length >= MAX_REVIEW_EVENTS) return { code: "history-full", reason: "This case has reached its review-history limit; it takes no further decisions." };
  const event: ReviewEvent = { at: input.now, from: current.status, to: input.to, note: input.note, reviewer: accountFingerprint(input.reviewerPrincipalId) };
  return { next: { ...current, revision: current.revision + 1, status: input.to, history: [...current.history, event] } };
}

/* ==================================================================
    THE VALIDATOR (a stored case is exactly this shape, or it is unreadable -- never guessed at)
   ================================================================== */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const time = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timeOrNull = (value: unknown) => value === null || time(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

const PARTY_KEYS = ["player_id", "principal_id", "nickname", "joined_at"];
const isParty = (value: unknown): value is ConductParty =>
  isObject(value) &&
  exact(value, PARTY_KEYS) &&
  typeof value.player_id === "string" &&
  PLAYER_ID.test(value.player_id) &&
  text(value.principal_id, 64) &&
  (value.principal_id as string).length > 0 &&
  text(value.nickname, 64) &&
  time(value.joined_at);

const COUNT_KEYS = ["offers", "accepted", "declined", "rescinded", "forgone", "undos", "passes", "actions"];
const isCounts = (value: unknown) => isObject(value) && exact(value, COUNT_KEYS) && COUNT_KEYS.every((key) => count(value[key]));

const isTimelineEntry = (value: unknown) => {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const base = ["i", "at", "type", "by", "derived"];
  if (!(keys.length === base.length || (keys.length === base.length + 1 && "outcome" in value))) return false;
  if (!base.every((key) => key in value)) return false;
  return (
    count(value.i) &&
    timeOrNull(value.at) &&
    typeof value.type === "string" &&
    (value.type === "?" || TYPE_NAME.test(value.type)) &&
    (value.by === "reporter" || value.by === "reported" || value.by === "other") &&
    typeof value.derived === "boolean" &&
    (value.outcome === undefined || value.outcome === "accepted" || value.outcome === "declined")
  );
};

const isChatLines = (value: unknown, limit: number): boolean =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every((line) => isObject(line) && exact(line, ["id", "at", "by", "text"]) && text(line.id, 64) && time(line.at) && (line.by === "reporter" || line.by === "reported") && text(line.text, 600));

const isReReport = (value: unknown): value is ReReport => {
  if (!isObject(value) || !exact(value, ["at", "note", "log", "counts", "chat"])) return false;
  const { log, counts } = value;
  if (!isObject(log) || typeof log.captured !== "boolean") return false;
  return (
    time(value.at) &&
    (value.note === null || (text(value.note, MAX_REPORT_NOTE_LENGTH * 2) && (value.note as string).length > 0)) &&
    isObject(log) &&
    exact(log, ["captured", "entries", "hash"]) &&
    count(log.entries) &&
    (log.hash === null || (typeof log.hash === "string" && HEX64.test(log.hash))) &&
    isObject(counts) &&
    exact(counts, ["reporter", "reported"]) &&
    isCounts(counts.reporter) &&
    isCounts(counts.reported) &&
    isChatLines(value.chat, REREPORT_CHAT_LIMIT)
  );
};

const TABLE_KEYS = ["visibility", "status", "money", "seats", "record_version", "created_at", "started_at", "completed_at", "closed_at", "last_activity_at"];
const EVIDENCE_KEYS = ["source", "captured_at", "server_build", "rules", "table", "log", "timeline", "counts", "chat", "money", "clock", "not_captured"];

function isEvidence(value: unknown): value is ConductEvidence {
  if (!isObject(value) || !exact(value, EVIDENCE_KEYS)) return false;
  const { rules, table, log, timeline, counts, chat, money, not_captured: notCaptured } = value;
  if (value.source !== "server" || !time(value.captured_at) || !text(value.server_build, 64)) return false;
  if (!isObject(rules) || !exact(rules, ["deal_pin", "engine"]) || !(rules.deal_pin === null || count(rules.deal_pin)) || !count(rules.engine)) return false;
  if (
    !isObject(table) ||
    !exact(table, TABLE_KEYS) ||
    !(table.visibility === "public" || table.visibility === "private") ||
    !text(table.status, 16) ||
    typeof table.money !== "boolean" ||
    !count(table.seats) ||
    !count(table.record_version) ||
    !time(table.created_at) ||
    !timeOrNull(table.started_at) ||
    !timeOrNull(table.completed_at) ||
    !timeOrNull(table.closed_at) ||
    !time(table.last_activity_at)
  ) {
    return false;
  }
  if (
    !isObject(log) ||
    !exact(log, ["captured", "entries", "hash", "window_from", "window_to"]) ||
    typeof log.captured !== "boolean" ||
    !count(log.entries) ||
    !(log.hash === null || (typeof log.hash === "string" && HEX64.test(log.hash))) ||
    !(log.window_from === null || count(log.window_from)) ||
    !(log.window_to === null || count(log.window_to))
  ) {
    return false;
  }
  if (!Array.isArray(timeline) || timeline.length > TIMELINE_LIMIT || !timeline.every(isTimelineEntry)) return false;
  if (!isObject(counts) || !exact(counts, ["reporter", "reported"]) || !isCounts(counts.reporter) || !isCounts(counts.reported)) return false;
  if (chat !== null) {
    if (!isObject(chat) || !exact(chat, ["lines"]) || !isChatLines(chat.lines, CHAT_LINES_LIMIT)) return false;
  }
  if (money !== null && (!isObject(money) || !exact(money, ["phase", "held"]) || !(money.phase === null || text(money.phase, 32)) || typeof money.held !== "boolean")) return false;
  if (!Array.isArray(notCaptured) || notCaptured.length > 16 || !notCaptured.every((line) => text(line, 300))) return false;
  return true;
}

const REVIEW_KEYS = ["at", "from", "to", "note", "reviewer"];
const isReviewEvent = (value: unknown): value is ReviewEvent =>
  isObject(value) &&
  exact(value, REVIEW_KEYS) &&
  time(value.at) &&
  isConductStatus(value.from) &&
  isConductStatus(value.to) &&
  (value.note === null || text(value.note, MAX_REVIEW_NOTE_LENGTH * 2)) &&
  typeof value.reviewer === "string" &&
  FINGERPRINT.test(value.reviewer);

export const CASE_KEYS = ["format", "version", "case_id", "seq", "game_id", "category", "created_at", "reporter", "reported", "table_principals", "note", "evidence", "rereports", "revision", "status", "history"] as const;

export function isConductCase(value: unknown): value is ConductCase {
  if (!isObject(value) || !exact(value, CASE_KEYS)) return false;
  if (value.format !== CONDUCT_CASE_FORMAT || value.version !== CONDUCT_CASE_VERSION) return false;
  if (typeof value.case_id !== "string" || !CASE_ID_PATTERN.test(value.case_id)) return false;
  if (typeof value.game_id !== "string" || !GAME_ID_PATTERN.test(value.game_id)) return false;
  if (!isConductReportCategory(value.category) || !time(value.created_at)) return false;
  if (!(typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0 && value.seq < MAX_CASE_SEQUENCE)) return false;
  if (!isParty(value.reporter) || !isParty(value.reported) || value.reporter.player_id === value.reported.player_id || value.reporter.principal_id === value.reported.principal_id) return false;
  if (!Array.isArray(value.table_principals) || value.table_principals.length > MAX_TABLE_PRINCIPALS || !value.table_principals.every((entry) => text(entry, 64) && (entry as string).length > 0)) return false;
  if (!Array.isArray(value.rereports) || value.rereports.length > MAX_REREPORTS || !value.rereports.every(isReReport)) return false;
  if (!(value.note === null || (text(value.note, MAX_REPORT_NOTE_LENGTH * 2) && (value.note as string).length > 0))) return false;
  if (!isEvidence(value.evidence)) return false;
  if (!(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1)) return false;
  if (!isConductStatus(value.status)) return false;
  if (!Array.isArray(value.history) || value.history.length > MAX_REVIEW_EVENTS || !value.history.every(isReviewEvent)) return false;
  /* The revision counts the decisions and the re-reports, and the status is the last decision's (or "open"): a case
     cannot disagree with its own history. */
  if (value.revision !== value.history.length + value.rereports.length + 1) return false;
  const last = value.history[value.history.length - 1] as ReviewEvent | undefined;
  if ((last?.to ?? "open") !== value.status) return false;
  return true;
}

/** Why a stored case could not be read: damage, or a newer build's format. Never overwritten. */
export class ConductCaseUnreadableError extends Error {
  constructor(
    message: string,
    readonly caseId: string,
    readonly newer: boolean = false,
  ) {
    super(message);
    this.name = "ConductCaseUnreadableError";
  }
}

/** Classify a stored case document (every store reads through this). */
export function parseConductCaseDocument(raw: string, caseId: string): ConductCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConductCaseUnreadableError(`the conduct case ${caseId} is not JSON`, caseId);
  }
  if (isObject(parsed) && parsed.format === CONDUCT_CASE_FORMAT && typeof parsed.version === "number" && parsed.version > CONDUCT_CASE_VERSION) {
    throw new ConductCaseUnreadableError(`the conduct case ${caseId} was written by a newer build (version ${parsed.version})`, caseId, true);
  }
  if (!isConductCase(parsed) || parsed.case_id !== caseId) throw new ConductCaseUnreadableError(`the conduct case ${caseId} is not a conduct case of that id`, caseId);
  return parsed;
}

/** The serialized form every store writes (one line), refused when it would exceed the bound. */
export function serializeConductCase(value: ConductCase): string | null {
  const textForm = JSON.stringify(value);
  return Buffer.byteLength(textForm, "utf8") <= MAX_CASE_BYTES ? textForm : null;
}

export const ALL_CONDUCT_STATUSES: readonly ConductStatus[] = CONDUCT_STATUSES;
