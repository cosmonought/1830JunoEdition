// frontend/src/utils/conductReport.ts
//
// ==================================================================
//  PHASE 3 (P3-N035): REPORTING A PLAYER'S CONDUCT -- THE WORDS AND THE RULES BOTH SIDES SHARE
// ==================================================================
//
// A report is a request for an operator to LOOK at something. It is not an accusation the system acts on: a report
// never punishes anyone, never changes a game, a seat, a profile, a trust fact or any money, and it is never shown to
// the player it names or to anyone else at the table. The server derives the evidence from its own records (the
// GameRecord and the committed game log); the reporter adds only a category and, optionally, a sentence or two.
//
// What lives here (pure, imported by the browser AND the server):
//   - the category labels players read (neutral, factual wording; the closed list itself is `messageSchema.ts`);
//   - the reviewer's statuses and their allowed transitions (a small factual workflow, no score);
//   - the one note sanitizer: NFC, every control / format character removed (bidi overrides, zero-width marks,
//     terminal escapes), whitespace collapsed to single spaces, trimmed; a note longer than the bound, or one that is
//     not well-formed Unicode, is REFUSED (never truncated, never "fixed").

import { CONDUCT_REPORT_CATEGORIES, MAX_REPORT_NOTE_LENGTH, sanitizeText, type ConductReportCategory } from "../gameEngine/messageSchema";

export { CONDUCT_REPORT_CATEGORIES, MAX_REPORT_NOTE_LENGTH, isConductReportCategory, type ConductReportCategory } from "../gameEngine/messageSchema";

/** What a reporter reads for each category (neutral: it names a kind of conduct, it does not assert motive). */
export const CONDUCT_CATEGORY_LABELS: Readonly<Record<ConductReportCategory, string>> = Object.freeze({
  stalling: "Deliberate stalling / timing abuse",
  "offer-spam": "Abusive trade-offer spam",
  harassment: "Harassment",
  collusion: "Suspected collusion",
  other: "Other",
});

/** One line under each category, so a reporter picks the closest one without being led. */
export const CONDUCT_CATEGORY_HINTS: Readonly<Record<ConductReportCategory, string>> = Object.freeze({
  stalling: "Holding up the table on purpose, for example to run down a timer.",
  "offer-spam": "Repeated offers used to disrupt play rather than to trade.",
  harassment: "Abusive or threatening chat or behaviour.",
  collusion: "Players appearing to coordinate outside what the rules allow.",
  other: "Anything else an operator should look at.",
});

export const CONDUCT_CATEGORY_ORDER: readonly ConductReportCategory[] = CONDUCT_REPORT_CATEGORIES;

/* ==================================================================
    THE REVIEWER'S STATUSES
   ================================================================== */

export const CONDUCT_STATUSES = ["open", "under-review", "no-violation", "conduct-confirmed", "escalated"] as const;
export type ConductStatus = (typeof CONDUCT_STATUSES)[number];
export const isConductStatus = (value: unknown): value is ConductStatus => typeof value === "string" && (CONDUCT_STATUSES as readonly string[]).includes(value);

export const CONDUCT_STATUS_LABELS: Readonly<Record<ConductStatus, string>> = Object.freeze({
  open: "Open",
  "under-review": "Under review",
  "no-violation": "No violation / closed",
  "conduct-confirmed": "Conduct issue confirmed",
  escalated: "Escalated",
});

/** The statuses a case may move to from each status. A closed case (no violation, or confirmed) can only be reopened
 *  to "under review"; nothing moves back to "open" (that is only where a report starts). */
export const CONDUCT_TRANSITIONS: Readonly<Record<ConductStatus, readonly ConductStatus[]>> = Object.freeze({
  open: ["under-review", "no-violation", "conduct-confirmed", "escalated"],
  "under-review": ["no-violation", "conduct-confirmed", "escalated"],
  escalated: ["under-review", "no-violation", "conduct-confirmed"],
  "no-violation": ["under-review"],
  "conduct-confirmed": ["under-review"],
});

export const conductTransitionAllowed = (from: ConductStatus, to: ConductStatus): boolean => CONDUCT_TRANSITIONS[from].includes(to);

/** A case is still waiting on a reviewer while it is open, under review or escalated. */
export const isConductCaseActive = (status: ConductStatus): boolean => status === "open" || status === "under-review" || status === "escalated";

/** A reviewer's note is longer than a reporter's (it records a decision), and is bounded the same way. */
export const MAX_REVIEW_NOTE_LENGTH = 1000;

/* ==================================================================
    THE NOTE SANITIZER (both sides)
   ================================================================== */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type NoteCheck = { readonly ok: true; readonly note: string | null } | { readonly ok: false; readonly problem: "too-long" | "malformed" };

/**
 * A free-text note, cleaned the one way: refused when it is not a string, is not well-formed Unicode, or is longer than
 * `max` code points BEFORE cleaning (a long note is never quietly cut); otherwise NFC, every control and format
 * character removed, every run of whitespace (newlines included) one space, trimmed. Empty after cleaning: `null`.
 */
export function checkConductNote(raw: unknown, max: number = MAX_REPORT_NOTE_LENGTH): NoteCheck {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: false, problem: "malformed" };
  if (LONE_SURROGATE.test(raw)) return { ok: false, problem: "malformed" };
  if (Array.from(raw).length > max) return { ok: false, problem: "too-long" };
  /* Whitespace first (a newline is a control character and would otherwise glue two words together). */
  const spaced = raw.replace(/\s+/g, " ");
  /* Cleaned with no cut (NFC can lengthen a text), then measured again: a note is refused, never shortened. */
  const clean = sanitizeText(spaced, Number.MAX_SAFE_INTEGER).replace(/ {2,}/g, " ").trim();
  if (Array.from(clean).length > max) return { ok: false, problem: "too-long" };
  return { ok: true, note: clean === "" ? null : clean };
}
