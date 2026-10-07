// server/src/rooms/clock/clockEvidence.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE CANONICAL CLOCK EVIDENCE -- AN APPEND-ONLY HASH CHAIN OF SERVER FACTS
// ==================================================================
//
// Escrow 2.1.0's REMEDY attestation signs `evidence_hash`: the SHA-256 of the control-plane clock evidence (stored by
// the contract, never interpreted). This module is that evidence's ONE canonical form:
//
//   event      a flat record of one server fact (responsibility began, an accepted action's reset, a train offer's
//              timer, an overdue, a cure, a vote, a pause, a system pause, a finality, a sealed remedy ...): integers and
//              short strings only -- no float, no secret, no wallet proof, no signature (an approval is evidenced by
//              its seat, horizon and the SHA-256 of its signature);
//   canonical  JSON with keys sorted at every level, no whitespace (`canonicalJson`);
//   chain      head_0 = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1/genesis" ‖ game_id);
//              head_n = SHA-256("18COSMOS/CLOCK-EVIDENCE/v1" ‖ head_{n-1} (32 bytes) ‖ canonical(event_n));
//   remedy     the attestation's `evidence_hash` is the head after the `remedy-sealed` event. The record keeps the
//              WINDOW of events since the defaulting obligation began (with the head before it), so anyone holding
//              the record can recompute that head; every event is also handed to the reporting hook and the ops audit
//              as it happens.
//
// Deterministic: the same facts in the same order hash the same on every build and platform.

import { createHash } from "crypto";

export const CLOCK_EVIDENCE_TAG = "18COSMOS/CLOCK-EVIDENCE/v1";
export const CLOCK_EVIDENCE_GENESIS_TAG = "18COSMOS/CLOCK-EVIDENCE/v1/genesis";
export const CLOCK_EVIDENCE_FORMAT = "18COSMOS/CLOCK-EVIDENCE/v1";

/** One evidence event: a kind, a sequence number, a server time (ms) and flat fields. */
export interface ClockEvidenceEvent {
  readonly seq: number;
  readonly kind: ClockEvidenceKind;
  readonly at: number;
  readonly f: Readonly<Record<string, string | number | boolean | null | readonly (string | number)[] | Readonly<Record<string, string | number>>>>;
}

export type ClockEvidenceKind =
  | "policy"
  | "responsibility"
  | "trade-begin"
  | "trade-end"
  | "overdue"
  | "cure"
  | "proposal"
  | "vote"
  | "veto"
  | "consensus"
  | "pause-request"
  | "pause-vote"
  | "pause-cancel"
  | "paused"
  | "resumed"
  | "system-pause"
  | "system-resume-vote"
  | "system-resumed"
  | "outage-credited"
  | "final"
  | "remedy-sealed"
  | "remedy-status"
  | "undo"
  | "annul-vote"
  | "ended"
  | "ack"
  | "vote-stale"
  | "reapproval";

/** Sorted-key, whitespace-free JSON. Only integers, booleans, null, strings and arrays / objects of them are allowed:
 *  a float (or a non-finite number) is refused -- evidence never carries one. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`clock evidence carries only safe integers, not ${String(value)}`);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error(`clock evidence cannot carry a ${typeof value}`);
}

export function genesisHead(gameId: string): string {
  return createHash("sha256").update(CLOCK_EVIDENCE_GENESIS_TAG, "utf8").update(gameId, "utf8").digest("hex");
}

/** head_n from head_{n-1} and event_n. */
export function nextHead(previous: string, event: ClockEvidenceEvent): string {
  if (!/^[0-9a-f]{64}$/.test(previous)) throw new Error("an evidence head is 32 bytes of lowercase hex");
  return createHash("sha256").update(CLOCK_EVIDENCE_TAG, "utf8").update(Buffer.from(previous, "hex")).update(canonicalJson(event), "utf8").digest("hex");
}

/** The head after folding `events` onto `from` (verifies a stored window). */
export function foldEvidence(from: string, events: readonly ClockEvidenceEvent[]): string {
  return events.reduce((head, event) => nextHead(head, event), from);
}

/** SHA-256 of a signature's hex (so an approval is evidenced without carrying the signature itself). */
export function signatureDigest(signatureHex: string): string {
  return createHash("sha256").update("18COSMOS/CLOCK-EVIDENCE/v1/signature", "utf8").update(signatureHex, "utf8").digest("hex");
}

/** The evidence document of one sealed remedy: the head before its window and the window (ending with the seal). Its
 *  fold is the attestation's `evidence_hash`. */
export interface RemedyEvidenceDocument {
  readonly format: typeof CLOCK_EVIDENCE_FORMAT;
  readonly game_id: string;
  readonly prev_head: string;
  readonly events: readonly ClockEvidenceEvent[];
  /** The window had to be bounded (more events than `CLOCK_EVIDENCE_WINDOW`): the head still covers everything. */
  readonly truncated: boolean;
}

export function evidenceHashOf(document: RemedyEvidenceDocument): string {
  return foldEvidence(document.prev_head, document.events);
}

/** The safe, authoritative conduct facts the player-reporting lane will consume (`phase3/preplaytest-player-reporting`):
 *  the event with the game it belongs to. No principal, wallet, proof or secret is ever in an event. */
export interface ClockConductEvidence {
  readonly game_id: string;
  readonly event: ClockEvidenceEvent;
  readonly head: string;
}

/** The reporting hook: told of every evidence event as it becomes durable (after the clock record's write). It must
 *  not throw and must not block; the clock never waits on it. */
export type ClockConductHook = (evidence: ClockConductEvidence) => void;
