// server/src/aws/controlPlane/flipRecord.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE FLIP'S MACHINE-READABLE EVIDENCE -- `18COSMOS/FLIP-EVIDENCE/v1`
// ==================================================================
//
// `gamesDoctor aws flip` writes one JSON document per flip (its `--flip-record <file>`), phase by phase, and reads it back to
// resume an observation (`flip-observe`). `awsDeploy verify --flip-record <file>` reads it to run the post-flip control-plane
// checks from the flip's own instant, and L6-6's staging harness consumes it as the certification evidence. It carries
// identifiers, versions, epochs, times, outcomes and check results -- never a credential, a note's secret (notes are
// refused if credential-shaped) or a document's content.

import * as fs from "fs";

export const FLIP_EVIDENCE_FORMAT = "18COSMOS/FLIP-EVIDENCE/v1";

export interface EvidenceCheck {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
}

export interface PoolEpoch {
  readonly epoch: number;
  readonly task: string;
}

export interface RoleSnapshot {
  readonly epoch: number;
  readonly pool: string;
  readonly task: string;
}

export interface FlipSnapshot {
  readonly at: number;
  readonly pools: Readonly<Record<string, PoolEpoch | null>>;
  readonly identity_writer: RoleSnapshot | null;
  readonly relayer: RoleSnapshot | null;
}

export type FlipVerdict =
  /** The preflight passed and --apply was not given: nothing was written. */
  | "planned"
  /** The preflight (or the CAS) refused: nothing of the flip was written. */
  | "refused"
  /** The routing moved; the tasks' role changes were not (yet) observed -- run `flip-observe`. */
  | "flipped"
  /** Both pools restarted into their new roles and the singleton roles moved to the new primary. */
  | "roles-settled"
  /** The observation's bound passed first: STOP -- nothing is assumed (resume with `flip-observe`). */
  | "timeout"
  /** The routing CAS's outcome is not known: re-run the same flip (it can never move the routing twice). */
  | "unknown";

export interface FlipRecord {
  readonly format: typeof FLIP_EVIDENCE_FORMAT;
  readonly environment: string;
  readonly from: string;
  readonly to: string;
  readonly expected_version: number;
  readonly note: string;
  /** `flip B A --rollback` (review M3): the routing moved back to the pool the roles never left. */
  readonly rollback?: boolean;
  readonly verdict: FlipVerdict;
  readonly preflight: { readonly at: number; readonly checks: readonly EvidenceCheck[] };
  readonly before: FlipSnapshot | null;
  /** The routing CAS (L6-3's set-primary: its operator run and evidence item). */
  readonly cas: null | { readonly at: number; readonly run: string | null; readonly outcome: string; readonly version: number | null; readonly detail: string };
  /** The planned-flip observability window (L6-5B: alarm ACTIONS on the expected role-change signals are suppressed only
   *  inside it, and only until `expires_at`). Closed when the roles settle AND the recovery pass settles. */
  readonly window: null | {
    readonly opened_at: number;
    readonly expires_at: number;
    readonly closed_at: number | null;
    /** LIVE-6 L6-5B: what became of this window's alarm suppression -- the open's outcome (`published`, `failed`,
     *  `refused`, `not-configured`), then `closed` once its close was decided. Only a `published` open is ever closed
     *  (the encoding is additive: a close without its open would cancel another window's). Absent: a record from before
     *  L6-5B -- no suppression was opened, none is closed. */
    readonly suppression?: "published" | "failed" | "refused" | "not-configured" | "nothing-to-publish" | "closed";
  };
  readonly observations: ReadonlyArray<{ readonly at: number; readonly checks: readonly EvidenceCheck[] }>;
  readonly after: FlipSnapshot | null;
}

/** Write the record (whole-file replace: a crash mid-write leaves the previous version or the new one, never a mix). */
export function writeFlipRecord(file: string, record: FlipRecord): void {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

export function parseFlipRecord(text: string): FlipRecord | { readonly problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { problem: "the flip record is not JSON" };
  }
  const r = raw as Partial<FlipRecord> | null;
  if (r === null || typeof r !== "object" || r.format !== FLIP_EVIDENCE_FORMAT) return { problem: `the flip record is not ${FLIP_EVIDENCE_FORMAT}` };
  if (typeof r.from !== "string" || typeof r.to !== "string" || typeof r.expected_version !== "number" || typeof r.environment !== "string") return { problem: "the flip record names no from / to / expected_version / environment" };
  return r as FlipRecord;
}

/** What `awsDeploy verify --flip-record` needs: the new primary, the routing version and the flip's instant. */
export function readFlipRecordFile(file: string): { readonly from: string; readonly to: string; readonly version: number; readonly since: number; readonly rollback: boolean } | { readonly problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { problem: `the flip record ${file} cannot be read (${error instanceof Error ? error.message.slice(0, 200) : String(error)})` };
  }
  const record = parseFlipRecord(text);
  if ("problem" in record) return record;
  if (record.cas === null || record.cas.version === null || !["flipped", "roles-settled", "timeout"].includes(record.verdict)) return { problem: `the flip record's verdict is ${record.verdict}: the routing was not moved by it` };
  /* Review L4: from the window's opening (before the CAS), so an exit 3/4 between the window and the CAS's answer is
     judged too; the CAS's own instant only when there is no window. */
  return { from: record.from, to: record.to, version: record.cas.version, since: Math.min(record.window?.opened_at ?? record.cas.at, record.cas.at), rollback: record.rollback === true };
}

/** LIVE-6 L6-5B: the planned-flip window a record states (null: none, or the file is not a flip record) -- for the
 *  verifier's suppression check (a suppressor may be ALARM only inside an open, unexpired window of its pool). */
export function flipWindowOfFile(file: string): { readonly from: string; readonly to: string; readonly opened_at: number; readonly expires_at: number; readonly closed_at: number | null } | null {
  try {
    const record = parseFlipRecord(fs.readFileSync(file, "utf8"));
    if ("problem" in record || record.window === null) return null;
    return { from: record.from, to: record.to, opened_at: record.window.opened_at, expires_at: record.window.expires_at, closed_at: record.window.closed_at };
  } catch {
    return null;
  }
}
