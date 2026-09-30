// server/src/aws/deploy/staging/evidence.ts
//
// ==================================================================
//  LIVE-6 L6-6: THE STAGING EVIDENCE PACKAGE -- FORMATS, THE RUN, SECRET REFUSAL, DETERMINISTIC BYTES, THE MANIFEST
// ==================================================================
//
// One staging certification is ONE RUN (`--run-id`, lower-case, used in the disposable DynamoDB keys) and ONE evidence
// directory. Everything the certification reads or writes lives there, and nothing in it may be secret:
//
//   prerequisite.json          `stage-cert prerequisite` (the L5-8 verifier + the settled-deployment checks), live
//   verify-ledger.json         `verify --part ledger --record <file>` (two-account form: the ledger half)
//   services.json ...          infra/aws/scripts/capture-evidence (read-only captures; L5-8's files + running tasks,
//                              target health, the cluster's running tasks, the distribution, capture.json's time)
//   probe-task-role-log.json   the certifier task's CloudWatch log events (infra/aws/scripts/run-task-probe)
//   probe-task-role-run.json   that task's `describe-tasks` (its definition, command override, exit code)
//   probe-task-role.json       the task-role probe's record, collected from the log (`stage-probe collect`)
//   probe-edge.json            `stage-probe edge` (the query string, the proxy hops, the WebSocket paths)
//   drain-<pool>.json          infra/aws/scripts/drain-pool with an evidence directory (replacement scenario)
//   terraform/<stack>/...      infra/aws/scripts/plan-evidence (version, lock, plan exit status, `show -json`)
//   certification.json         `stage-cert certify`: the machine-readable verdict
//   CERTIFICATION.txt          the human-readable verdict (first line: LIVE-6 AWS STAGING CERTIFICATION: PASS|FAIL)
//   MANIFEST.json              SHA-256 of every file above, for the audit
//
// SECRETS ARE REFUSED, NOT REDACTED AFTER THE FACT: a record this harness would write that carries secret-shaped
// material is never written (the probe fails instead), and an evidence file that carries any is a FAILED gate -- the
// certification never passes over a package that leaked. What counts (`secretFindings`): AWS access key ids, secret
// keys and session tokens; PEM private keys; the session cookie (`__Host-gs_session`, its `v1.<id>.<secret>` value);
// cookie / authorization headers; JWTs; and, in the harness's own records, fields named for credentials, recovery
// material, wallet-control proofs or raw player identity. A probe records hashes, counts, codes and booleans instead.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { Check } from "../deployVerify";

export const PROBE_FORMAT = "18COSMOS/L6-6-PROBE/v1";
export const PREREQUISITE_FORMAT = "18COSMOS/L6-6-PREREQUISITE/v1";
export const CERTIFICATION_FORMAT = "18COSMOS/L6-6-CERTIFICATION/v1";
export const VERIFY_RECORD_FORMAT = "18COSMOS/L5-8-VERIFY/v1";
/** The line prefix the in-task probe prints its record chunks under (CloudWatch -> `stage-probe collect`). */
export const LOG_RECORD_PREFIX = "L6CERT/v1";

export const EVIDENCE = Object.freeze({
  prerequisite: "prerequisite.json",
  verifyLedger: "verify-ledger.json",
  runningTasks: "running-tasks.json",
  clusterTasks: "cluster-tasks.json",
  targetHealth: "target-health.json",
  /** capture-evidence's own stamp: when the control-plane files were captured. */
  capture: "capture.json",
  /** `aws cloudfront get-distribution` (its DomainName: the name the edge probe must use). */
  distribution: "distribution.json",
  taskRoleLog: "probe-task-role-log.json",
  taskRoleRun: "probe-task-role-run.json",
  taskRole: "probe-task-role.json",
  edge: "probe-edge.json",
  drain: (pool: string) => `drain-${pool}.json`,
  terraformDir: (stack: string) => path.join("terraform", stack),
  certification: "certification.json",
  certificationText: "CERTIFICATION.txt",
  manifest: "MANIFEST.json",
});

/** A run id: lower-case, 6-40 characters, used verbatim in the disposable keys (`L6CERT#<run>`). */
export const RUN_ID = /^[a-z0-9][a-z0-9-]{5,39}$/;
export const runIdProblem = (run: string): string | null => (RUN_ID.test(run) ? null : "--run-id must match ^[a-z0-9][a-z0-9-]{5,39}$ (it names the run's disposable keys)");

/** The ONE game-table partition the transaction probe writes (and deletes) -- never read by any production path: the
 *  game table's scans filter `JOIN#`, and every index is a named partition (`aws/game/gameTable.ts`). */
export const disposablePartition = (run: string): string => `L6CERT#${run}`;
/** The IAM probe's forbidden-write target: the `SYSTEM` partition (never ROUTING), a sort key no record uses. */
export const forbiddenSystemSortKey = (run: string): string => `L6CERT-${run}`;

export const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
export const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
export const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
/** A short, non-reversible label for an identifier (a key ARN is never a metric dimension or a report field). */
export const fingerprint = (text: string): string => sha256Hex(text).slice(0, 12);

/* ------------------------------------------------------------------ */
/* Deterministic JSON                                                   */
/* ------------------------------------------------------------------ */

/** JSON with every object's keys sorted (arrays keep their order): the same record is always the same bytes. */
export function stableStringify(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner !== undefined) out[key] = sort(inner);
      }
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

/* ------------------------------------------------------------------ */
/* Secret refusal                                                       */
/* ------------------------------------------------------------------ */

const VALUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["an AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["an AWS secret key or session token field", /aws_secret_access_key|SecretAccessKey|"SessionToken"\s*:|X-Amz-Security-Token/i],
  ["a PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["the session cookie", /__Host-gs_session\s*=/i],
  ["a session cookie value", /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
  ["a cookie or authorization header", /"(?:cookie|set-cookie|authorization|proxy-authorization)"\s*:/i],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

/** Field names the harness's OWN records never carry (credentials, recovery material, wallet proofs, player identity). */
const RECORD_FIELD_PATTERN = /"(?:mnemonic|seed|seed_phrase|private_key|privateKey|secret|secret_key|password|recovery_key|recovery_code|recovery_material|wallet_proof|wallet_control_proof|adr036|signature_der|signature_hex|signed_doc|principal_id|principalId|player_id|playerId|session_id|sessionId|session_cookie|cookie_value|access_key_id|secret_access_key|session_token)"\s*:/;

/** What in `text` looks secret (empty: nothing). `ownRecord`: also refuse the credential / identity field names. */
export function secretFindings(text: string, options: { readonly ownRecord?: boolean } = {}): string[] {
  const found = VALUE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
  if (options.ownRecord === true && RECORD_FIELD_PATTERN.test(text)) found.push("a credential, recovery, wallet-proof or player-identity field");
  return found;
}

/** Remove every occurrence of `secret` from `text` (an error message that might quote a header, say). */
export const scrub = (text: string, secrets: readonly string[]): string => secrets.filter((s) => s.length >= 4).reduce((t, s) => t.split(s).join("<redacted>"), text);

export class EvidenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceRefusedError";
  }
}

/** Write one of the harness's records (deterministic bytes); refused -- nothing written -- if it looks secret. */
export function writeRecord(dir: string, file: string, record: unknown): string {
  const text = stableStringify(record);
  const findings = secretFindings(text, { ownRecord: true });
  if (findings.length > 0) throw new EvidenceRefusedError(`refusing to write ${file}: it carries ${findings.join(", ")}`);
  const where = path.join(dir, file);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, text, "utf8");
  return where;
}

export type EvidenceRead = { readonly ok: true; readonly value: unknown; readonly sha256: string } | { readonly ok: false; readonly problem: string };

/** One evidence file: present, JSON (a PowerShell BOM tolerated) and free of secret-shaped material. */
export function readEvidence(dir: string, file: string, options: { readonly ownRecord?: boolean } = {}): EvidenceRead {
  const where = path.join(dir, file);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(where);
  } catch {
    return { ok: false, problem: `${file} is missing` };
  }
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  const findings = secretFindings(text, options);
  if (findings.length > 0) return { ok: false, problem: `${file} carries ${findings.join(", ")}: the package is refused (it must hold no secret)` };
  try {
    return { ok: true, value: JSON.parse(text) as unknown, sha256: sha256Hex(bytes) };
  } catch {
    return { ok: false, problem: `${file} is not JSON` };
  }
}

/** A text evidence file (a plan exit status, a lock file), scanned like the rest. */
export function readEvidenceText(dir: string, file: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly problem: string } {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "");
  } catch {
    return { ok: false, problem: `${file} is missing` };
  }
  const findings = secretFindings(text);
  if (findings.length > 0) return { ok: false, problem: `${file} carries ${findings.join(", ")}` };
  return { ok: true, text };
}

/** The in-task probe prints its record as base64 chunks (Docker's log driver splits lines over 16 KiB). */
export const RECORD_CHUNK = 6_000;

export function recordLines(record: unknown): string[] {
  const text = stableStringify(record, 0);
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const digest = sha256Hex(text);
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += RECORD_CHUNK) chunks.push(encoded.slice(i, i + RECORD_CHUNK));
  return chunks.map((chunk, i) => `${LOG_RECORD_PREFIX} ${i + 1}/${chunks.length} ${digest} ${chunk}`);
}

/** The record back from log lines (CloudWatch `get-log-events` output, or plain text lines). */
export function recordFromLog(messages: readonly string[]): { readonly ok: true; readonly record: unknown } | { readonly ok: false; readonly problem: string } {
  const parts = new Map<number, string>();
  let total: number | null = null;
  let digest: string | null = null;
  for (const message of messages) {
    const at = message.indexOf(`${LOG_RECORD_PREFIX} `);
    if (at < 0) continue;
    const m = /^(\d+)\/(\d+) ([0-9a-f]{64}) ([A-Za-z0-9+/=]+)\s*$/.exec(message.slice(at + LOG_RECORD_PREFIX.length + 1));
    if (m === null) return { ok: false, problem: "a malformed record line" };
    if (digest !== null && (m[3] !== digest || Number(m[2]) !== total)) return { ok: false, problem: "record lines from two different records (one certifier task per log)" };
    digest = m[3];
    total = Number(m[2]);
    parts.set(Number(m[1]), m[4]);
  }
  if (total === null || digest === null) return { ok: false, problem: `no ${LOG_RECORD_PREFIX} record in the log` };
  for (let i = 1; i <= total; i += 1) if (!parts.has(i)) return { ok: false, problem: `record chunk ${i} of ${total} is missing` };
  const text = Buffer.from([...Array(total).keys()].map((i) => parts.get(i + 1)).join(""), "base64").toString("utf8");
  if (sha256Hex(text) !== digest) return { ok: false, problem: "the reassembled record does not match its SHA-256" };
  try {
    return { ok: true, record: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, problem: "the reassembled record is not JSON" };
  }
}

/** The text a scan must see: the file's, plus -- for a log carrying the in-task record -- the record decoded from its
 *  base64 chunks (base64 would hide anything secret-shaped from a plain scan). */
const scannableText = (text: string): string => {
  if (!text.includes(`${LOG_RECORD_PREFIX} `)) return text;
  const decoded = [...text.matchAll(/L6CERT\/v1 \d+\/\d+ [0-9a-f]{64} ([A-Za-z0-9+/=]+)/g)].map((m) => m[1]).join("");
  return `${text}\n${Buffer.from(decoded, "base64").toString("utf8")}`;
};

/** Every file under `dir` (sorted, `/`-separated), its size and SHA-256, and any secret-shaped material in it. The
 *  manifest itself and the certification outputs are not listed (they are written after it). */
export function manifestOf(dir: string, exclude: readonly string[] = [EVIDENCE.manifest, EVIDENCE.certification, EVIDENCE.certificationText]): Array<{ readonly file: string; readonly bytes: number; readonly sha256: string; readonly findings: readonly string[] }> {
  const out: Array<{ file: string; bytes: number; sha256: string; findings: string[] }> = [];
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else {
        const file = path.relative(dir, full).split(path.sep).join("/");
        if (exclude.includes(file)) continue;
        const bytes = fs.readFileSync(full);
        out.push({ file, bytes: bytes.length, sha256: sha256Hex(bytes), findings: secretFindings(scannableText(bytes.toString("utf8"))) });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

/** What every probe record carries, so a record from another run, environment or deployment is never counted. */
export interface ProbeEnvelope {
  readonly format: typeof PROBE_FORMAT;
  readonly probe: string;
  readonly run_id: string;
  readonly environment: string;
  readonly generation: number;
  readonly pool: string;
  /** ISO-8601 (UTC) of the probe's start and end, from the machine that ran it. */
  readonly started_at: string;
  readonly finished_at: string;
}

type Json = unknown;
export const obj = (value: Json): Record<string, Json> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {});
export const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
export const str = (value: Json): string | null => (typeof value === "string" ? value : null);
export const num = (value: Json): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The envelope's checks: this run, this deployment, a real time span. */
export function checkEnvelope(label: string, record: Json, expect: { readonly probe: string; readonly run: string; readonly environment: string; readonly generation: number; readonly pool: string; readonly notBefore: string | null }): Check[] {
  const r = obj(record);
  const started = Date.parse(String(r.started_at));
  const finished = Date.parse(String(r.finished_at));
  const notBefore = expect.notBefore === null ? Number.NEGATIVE_INFINITY : Date.parse(expect.notBefore);
  return [
    judge(`${label}: format`, r.format === PROBE_FORMAT && r.probe === expect.probe, `${PROBE_FORMAT} ${expect.probe}`, `format ${String(r.format)}, probe ${String(r.probe)}`),
    judge(`${label}: this run`, r.run_id === expect.run, expect.run, `run ${String(r.run_id)}, not ${expect.run} (evidence from another run is never counted)`),
    judge(
      `${label}: this deployment`,
      r.environment === expect.environment && r.generation === expect.generation && r.pool === expect.pool,
      `${expect.environment} g${expect.generation} ${expect.pool}`,
      `${String(r.environment)} g${String(r.generation)} ${String(r.pool)}`,
    ),
    judge(
      `${label}: after the prerequisite`,
      Number.isFinite(started) && Number.isFinite(finished) && finished >= started && started >= notBefore,
      `${String(r.started_at)} .. ${String(r.finished_at)}`,
      `the probe ran ${String(r.started_at)} .. ${String(r.finished_at)}, not after the prerequisite (${expect.notBefore ?? "none"})`,
    ),
  ];
}

export const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The one verdict law: PASS only if every check passed. A skipped check is NOT a pass. */
export const allPass = (checks: readonly Check[]): boolean => checks.length > 0 && checks.every((c) => c.status === "pass");
