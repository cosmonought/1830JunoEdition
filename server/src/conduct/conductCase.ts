// server/src/conduct/conductCase.ts
//
// ==================================================================
//  PHASE 3 (P3-N032): A CONDUCT REPORT'S DURABLE REVIEW CASE -- THE RECORD, ITS EVIDENCE, AND ITS REVIEW HISTORY
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
  /** The authoritative log, by reference: its first `entries` entries hash to `hash` (`logHash`). */
  readonly log: { readonly entries: number; readonly hash: string | null; readonly window_from: number | null; readonly window_to: number | null };
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

export interface ConductCase {
  readonly format: typeof CONDUCT_CASE_FORMAT;
  readonly version: typeof CONDUCT_CASE_VERSION;
  readonly case_id: string;
  readonly game_id: string;
  readonly category: ConductReportCategory;
  readonly created_at: number;
  readonly reporter: ConductParty;
  readonly reported: ConductParty;
  /** The reporter's note, sanitized (`checkConductNote`), or null. Shown to reviewers only. */
  readonly note: string | null;
  readonly evidence: ConductEvidence;
  /** CAS counter: 1 at creation, +1 per review decision. */
  readonly revision: number;
  readonly status: ConductStatus;
  readonly history: readonly ReviewEvent[];
}

/* ==================================================================
    IDS AND FINGERPRINTS
   ================================================================== */

/**
 * The case id: ONE case per (game, reporting account, reported seat, category). A second submission of the same report
 * -- a double click, another tab, a retry after a lost answer, or the same complaint again later in the game -- finds
 * the case that stands instead of making another, so a report is never counted twice and a reporter cannot multiply
 * cases about one player at one table (the reviewer reads the whole game's record anyway).
 */
export function conductCaseId(gameId: string, reporterPrincipalId: string, reportedPlayerId: string, category: ConductReportCategory): string {
  const digest = createHash("sha256").update(`18COSMOS/CONDUCT-CASE/v1\u0000${gameId}\u0000${reporterPrincipalId}\u0000${reportedPlayerId}\u0000${category}`, "utf8").digest("hex");
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

const emptyCounts = (): { -readonly [K in keyof OfferCounts]: number } => ({ offers: 0, accepted: 0, declined: 0, rescinded: 0, forgone: 0, undos: 0, passes: 0, actions: 0 });

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

/** What the server captures for a case, from its own records only. */
export function deriveEvidence(input: EvidenceInput): ConductEvidence {
  const { record, entries, reporter, reported } = input;
  const ordered = [...entries].sort((left, right) => left.index - right.index);
  const partyOf = (actor: string): TimelineParty => (actor === reporter.player_id ? "reporter" : actor === reported.player_id ? "reported" : "other");
  const counts = { reporter: emptyCounts(), reported: emptyCounts() };
  for (const entry of ordered) {
    const party = partyOf(entry.actor);
    if (party === "other") continue;
    tally(counts[party], entryKind(entry), entry.derived === true);
  }
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
  const chat =
    input.chat === null
      ? null
      : {
          lines: input.chat
            .filter((line) => line.author === reporter.player_id || line.author === reported.player_id)
            .slice(-CHAT_LINES_LIMIT)
            .map((line) => ({ id: String(line.id).slice(0, 64), at: line.at, by: line.author === reporter.player_id ? ("reporter" as const) : ("reported" as const), text: String(line.text).slice(0, 600) })),
        };
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
    log: { entries: ordered.length, hash, window_from: window.length > 0 ? window[0].index : null, window_to: window.length > 0 ? window[window.length - 1].index : null },
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
  if (evidence.log.entries === 0) return { verified: null, detail: "The game had no log entries when the report was made." };
  if (evidence.log.hash === null) return { verified: null, detail: "The case carries no log hash (see what was not captured)." };
  if (entries.length < evidence.log.entries) return { verified: false, detail: `The log now holds ${entries.length} entries, fewer than the ${evidence.log.entries} the report saw.` };
  let now: string;
  try {
    now = logHash(entries, evidence.log.entries);
  } catch (error) {
    return { verified: false, detail: `The log could not be hashed: ${error instanceof Error ? error.message : String(error)}` };
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
}): ConductCase {
  return {
    format: CONDUCT_CASE_FORMAT,
    version: CONDUCT_CASE_VERSION,
    case_id: conductCaseId(input.record.game_id, input.reporter.principal_id, input.reported.player_id, input.category),
    game_id: input.record.game_id,
    category: input.category,
    created_at: input.now,
    reporter: input.reporter,
    reported: input.reported,
    note: input.note,
    evidence: input.evidence,
    revision: 1,
    status: "open",
    history: [],
  };
}

export type DecisionRefusal =
  | { readonly code: "stale"; readonly reason: string }
  | { readonly code: "wrong-state"; readonly reason: string }
  | { readonly code: "party"; readonly reason: string }
  | { readonly code: "history-full"; readonly reason: string };

/** The next case after a reviewer's decision, or why it is refused. Pure: the store's CAS decides the race. */
export function decideCase(current: ConductCase, input: { readonly expectedRevision: number; readonly to: ConductStatus; readonly note: string | null; readonly reviewerPrincipalId: string; readonly now: number }): { readonly next: ConductCase } | DecisionRefusal {
  if (current.revision !== input.expectedRevision) return { code: "stale", reason: "This case changed since you opened it. Reload it and decide again." };
  if (input.reviewerPrincipalId === current.reporter.principal_id || input.reviewerPrincipalId === current.reported.principal_id) {
    return { code: "party", reason: "You are a party to this case, so another reviewer must decide it." };
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

const PARTY_KEYS = ["player_id", "principal_id", "nickname"];
const isParty = (value: unknown): value is ConductParty =>
  isObject(value) && exact(value, PARTY_KEYS) && typeof value.player_id === "string" && PLAYER_ID.test(value.player_id) && text(value.principal_id, 64) && (value.principal_id as string).length > 0 && text(value.nickname, 64);

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
    !exact(log, ["entries", "hash", "window_from", "window_to"]) ||
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
    if (!isObject(chat) || !exact(chat, ["lines"]) || !Array.isArray(chat.lines) || chat.lines.length > CHAT_LINES_LIMIT) return false;
    for (const line of chat.lines) {
      if (!isObject(line) || !exact(line, ["id", "at", "by", "text"]) || !text(line.id, 64) || !time(line.at) || !(line.by === "reporter" || line.by === "reported") || !text(line.text, 600)) return false;
    }
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

export const CASE_KEYS = ["format", "version", "case_id", "game_id", "category", "created_at", "reporter", "reported", "note", "evidence", "revision", "status", "history"] as const;

export function isConductCase(value: unknown): value is ConductCase {
  if (!isObject(value) || !exact(value, CASE_KEYS)) return false;
  if (value.format !== CONDUCT_CASE_FORMAT || value.version !== CONDUCT_CASE_VERSION) return false;
  if (typeof value.case_id !== "string" || !CASE_ID_PATTERN.test(value.case_id)) return false;
  if (typeof value.game_id !== "string" || !GAME_ID_PATTERN.test(value.game_id)) return false;
  if (!isConductReportCategory(value.category) || !time(value.created_at)) return false;
  if (!isParty(value.reporter) || !isParty(value.reported) || value.reporter.player_id === value.reported.player_id) return false;
  if (!(value.note === null || (text(value.note, MAX_REPORT_NOTE_LENGTH * 2) && (value.note as string).length > 0))) return false;
  if (!isEvidence(value.evidence)) return false;
  if (!(typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 1)) return false;
  if (!isConductStatus(value.status)) return false;
  if (!Array.isArray(value.history) || value.history.length > MAX_REVIEW_EVENTS || !value.history.every(isReviewEvent)) return false;
  /* The revision counts the decisions, and the status is the last decision's (or "open"): a case cannot disagree with
     its own history. */
  if (value.revision !== value.history.length + 1) return false;
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
