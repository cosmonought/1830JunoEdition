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
//
// LIVE-6 RELAYER ROTATION (v2 of the rotation record). The gate also records, from the SAME configuration it judged, the
// deployment the rotation must leave untouched -- the chain, the contract and its certified code checksums, the
// settlement key (its registry id, public key and KMS key reference) and the admission key (public key and key
// reference) -- and the relayer key it rotates FROM, plus the escrow contract's operator as the chain answered at the
// gate. The certification's post-rotation proof (`staging/rotationProof.ts`) compares the live deployment with THIS
// machine record, never with values typed by hand. A v1 record carries none of it and no longer certifies a rotation.

import * as fs from "fs";
import * as path from "path";

import type { Check } from "../controlPlane/evidence";

export const GENERATION_GATE_FORMAT = "18COSMOS/GENERATION-GATE/v1";
export const ROTATION_GATE_FORMAT = "18COSMOS/RELAYER-ROTATION-GATE/v2";
/** The L6-5B record: still readable by name, refused by certification (it carries no deployment identity). */
export const ROTATION_GATE_FORMAT_V1 = "18COSMOS/RELAYER-ROTATION-GATE/v1";

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

/** What a relayer rotation must leave exactly as it was (all public: addresses, ids, public keys, KMS key ARNs). */
export interface RotationDeploymentIdentity {
  readonly chain_id: string;
  readonly contract_address: string;
  /** The configuration's certified code checksums, sorted. */
  readonly code_checksums: readonly string[];
  readonly settlement_key: { readonly signer_key_id: number; readonly public_key_hex: string; readonly key_ref: string };
  readonly admission_key: { readonly public_key_hex: string; readonly key_ref: string };
  /** The relayer key the configuration named at the gate (the key rotated FROM). */
  readonly from_relayer_key_ref: string;
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
  /** v2: the deployment the rotation must leave untouched, from the configuration the gate judged (null: no escrow). */
  readonly deployment: RotationDeploymentIdentity | null;
  /** v2: the escrow contract's operator as the chain answered at the gate (null: not read). */
  readonly contract_operator: string | null;
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

const HEX33 = /^0[23][0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_REF = /^[\x21-\x7e]{1,256}$/;

/** The record's deployment identity, strictly (null: absent or malformed -- never partly read). */
export function rotationDeploymentOf(record: unknown): RotationDeploymentIdentity | null {
  if (!isObj(record) || !isObj(record.deployment)) return null;
  const d = record.deployment;
  const s = isObj(d.settlement_key) ? d.settlement_key : null;
  const a = isObj(d.admission_key) ? d.admission_key : null;
  const text = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
  if (!text(d.chain_id, /^[a-z0-9][a-z0-9-]{0,63}$/) || !text(d.contract_address, /^[a-z][a-z0-9]{0,15}1[02-9ac-hj-np-z]{38,90}$/) || !text(d.from_relayer_key_ref, KEY_REF)) return null;
  if (!Array.isArray(d.code_checksums) || d.code_checksums.length === 0 || !d.code_checksums.every((c) => text(c, SHA256))) return null;
  if (s === null || typeof s.signer_key_id !== "number" || !Number.isInteger(s.signer_key_id) || s.signer_key_id < 1 || !text(s.public_key_hex, HEX33) || !text(s.key_ref, KEY_REF)) return null;
  if (a === null || !text(a.public_key_hex, HEX33) || !text(a.key_ref, KEY_REF)) return null;
  return {
    chain_id: d.chain_id,
    contract_address: d.contract_address,
    code_checksums: [...(d.code_checksums as string[])].sort(),
    settlement_key: { signer_key_id: s.signer_key_id, public_key_hex: s.public_key_hex, key_ref: s.key_ref },
    admission_key: { public_key_hex: a.public_key_hex, key_ref: a.key_ref },
    from_relayer_key_ref: d.from_relayer_key_ref,
  };
}

/** Why `record` does not prove the relayer rotation may proceed (null: it does). */
export function rotationGateRecordProblem(record: unknown, expect: { readonly environment: string; readonly from: string; readonly to: string }): string | null {
  if (isObj(record) && record.format === ROTATION_GATE_FORMAT_V1) return `a ${ROTATION_GATE_FORMAT_V1} record carries no deployment identity and no contract operator: run the gate again (it writes ${ROTATION_GATE_FORMAT})`;
  if (!isObj(record) || record.format !== ROTATION_GATE_FORMAT) return "not a relayer-rotation-gate record (the gate's `--record` output)";
  if (record.environment !== expect.environment) return `the record is for ${String(record.environment)}, not ${expect.environment}`;
  if (record.from_relayer !== expect.from || record.to_relayer !== expect.to) return `the record gates ${String(record.from_relayer)} -> ${String(record.to_relayer)}, not ${expect.from} -> ${expect.to}`;
  if (record.configured_relayer !== expect.from) return `at the gate the configuration named ${String(record.configured_relayer)}, not the old relayer`;
  if (record.queue !== "empty") return `RELAYQ#${expect.from} was ${String(record.queue)} at the gate (only a queue read completely and empty opens it)`;
  if (record.verdict !== "OPEN" || !checksPassed(record.checks)) return "the rotation gate was not OPEN";
  if (rotationDeploymentOf(record) === null) return "the record carries no well-formed deployment identity (chain, contract, checksums, settlement and admission keys, the old relayer key)";
  if (record.contract_operator !== expect.from && record.contract_operator !== expect.to) return `at the gate the escrow contract's operator was ${String(record.contract_operator)}, neither the old nor the new relayer`;
  return null;
}
