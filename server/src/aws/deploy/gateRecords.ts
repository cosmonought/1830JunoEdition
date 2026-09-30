// server/src/aws/deploy/gateRecords.ts
//
// ==================================================================
//  LIVE-6 L6-5B: THE GATES' MACHINE-PRODUCED EVIDENCE -- WRITTEN BY THE GATE, JUDGED BY CERTIFICATION (PURE + ONE WRITE)
// ==================================================================
//
// Two deployment gates (L6-2) decide a step the pipeline must not take early:
//   `awsDeploy generation-gate`       the Terraform generation switch (its printed `generation_adoption` is what the app
//                                     stack's plan requires -- owner decision: the plan relies on this attestation
//                                     instead of a cross-account ledger read);
//   `awsDeploy relayer-rotation-gate` a change of the relayer address (the old RELAYQ# proven empty, every pool drained).
// Each prints its verdict for a human. With `--record <file>` it ALSO writes the verdict as a machine record, created once
// (an existing file is never overwritten), so staging certification (L6-6) preserves the gate's OWN output and binds to
// it -- never to a value typed by hand:
//   - `generationAttestationProblem`: the Terraform `generation_adoption` equals the attestation of an OPEN
//     generation-gate record of the SAME environment, generation, table and restore (an arbitrary replacement fails);
//   - `rotationGateRecordProblem`: an OPEN rotation record for exactly this environment and from/to address pair, every
//     check passed, the old queue proven EMPTY (an unknown or closed gate fails certification).
// Records carry no secret, no key and no game: addresses, table names, ids, check names and their details.

import * as fs from "fs";
import * as path from "path";

import type { Check } from "../controlPlane/evidence";

export const GENERATION_GATE_FORMAT = "18COSMOS/GENERATION-GATE/v1";
export const ROTATION_GATE_FORMAT = "18COSMOS/RELAYER-ROTATION-GATE/v1";

export interface GenerationAttestation {
  readonly generation: number;
  readonly game_table: string;
  readonly restore_id: string;
}

export interface GenerationGateRecord {
  readonly format: typeof GENERATION_GATE_FORMAT;
  readonly environment: string;
  readonly from_generation: number;
  readonly verdict: "OPEN" | "CLOSED";
  /** The value the app stack's `generation_adoption` must equal (null when CLOSED). */
  readonly attestation: GenerationAttestation | null;
  /** The adoption the ledger holds: its one transaction's claim (history and APPGEN agree on it when OPEN). */
  readonly adoption_claim: string | null;
  readonly checks: readonly Check[];
  readonly gated_at: string;
}

export interface RotationGateRecord {
  readonly format: typeof ROTATION_GATE_FORMAT;
  readonly environment: string;
  readonly from_relayer: string;
  readonly to_relayer: string;
  /** What the active configuration names at the gate. */
  readonly configured_relayer: string | null;
  readonly pools: readonly string[];
  /** The control-plane capture the drain was judged on. */
  readonly evidence_captured_at: string | null;
  /** RELAYQ#<from_relayer>: `empty` (read completely), `open` (entries), `unknown` (not proven). */
  readonly queue: "empty" | "open" | "unknown";
  readonly verdict: "OPEN" | "CLOSED";
  readonly checks: readonly Check[];
  readonly gated_at: string;
}

/** Create the record file (never overwrite an existing one: a gate's evidence is written once). */
export function writeGateRecord(file: string, record: GenerationGateRecord | RotationGateRecord): void {
  const dir = path.dirname(path.resolve(file));
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  try {
    fs.linkSync(temp, file); // fails if `file` exists: never replaces an earlier gate's evidence
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Every check the gate ran passed or was reported skipped by name (e.g. the rotation gate's "the new queue is never
 *  consulted"), at least one passed, and none failed (review M2: the gate's REAL record must bind). */
const checksPassed = (v: unknown): boolean => Array.isArray(v) && v.some((c) => isObj(c) && c.status === "pass") && v.every((c) => isObj(c) && (c.status === "pass" || c.status === "skipped"));

/**
 * Why `planned` (the app stack's `generation_adoption`) is NOT the gate's own attestation (null: it is). The record must
 * be an OPEN generation-gate record of this environment whose every check passed, and the planned value must equal its
 * attestation field for field -- the generation, the table and the restore.
 */
export function generationAttestationProblem(record: unknown, planned: GenerationAttestation | null, expect: { readonly environment: string }): string | null {
  if (!isObj(record) || record.format !== GENERATION_GATE_FORMAT) return "not a generation-gate record (the gate's `--record` output)";
  if (record.environment !== expect.environment) return `the record is for ${String(record.environment)}, not ${expect.environment}`;
  if (record.verdict !== "OPEN" || !checksPassed(record.checks)) return "the generation gate was not OPEN (a closed or unknown gate never attests an adoption)";
  const a = record.attestation;
  if (!isObj(a) || typeof a.generation !== "number" || typeof a.game_table !== "string" || typeof a.restore_id !== "string") return "the record carries no attestation";
  if (planned === null) return "the plan carries no generation_adoption: a restored serving table needs the gate's attestation";
  const diff = (["generation", "game_table", "restore_id"] as const).filter((k) => planned[k] !== a[k]);
  return diff.length === 0 ? null : `generation_adoption differs from the gate's attestation in ${diff.join(", ")} (only the gate's own value is accepted)`;
}

/** Why `record` does not prove the relayer rotation may proceed (null: it does). */
export function rotationGateRecordProblem(record: unknown, expect: { readonly environment: string; readonly from: string; readonly to: string }): string | null {
  if (!isObj(record) || record.format !== ROTATION_GATE_FORMAT) return "not a relayer-rotation-gate record (the gate's `--record` output)";
  if (record.environment !== expect.environment) return `the record is for ${String(record.environment)}, not ${expect.environment}`;
  if (record.from_relayer !== expect.from || record.to_relayer !== expect.to) return `the record gates ${String(record.from_relayer)} -> ${String(record.to_relayer)}, not ${expect.from} -> ${expect.to}`;
  if (record.configured_relayer !== expect.from) return `at the gate the configuration named ${String(record.configured_relayer)}, not the old relayer`;
  if (record.queue !== "empty") return `RELAYQ#${expect.from} was ${String(record.queue)} at the gate (only a queue read completely and empty opens it)`;
  if (record.verdict !== "OPEN" || !checksPassed(record.checks)) return "the rotation gate was not OPEN";
  return null;
}
