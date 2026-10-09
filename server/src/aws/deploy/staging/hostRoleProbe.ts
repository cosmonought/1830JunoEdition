// server/src/aws/deploy/staging/hostRoleProbe.ts
//
// ==================================================================
//  PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md F5 / F6): THE HOST-ROLE PROBES, JUDGED OFFLINE
// ==================================================================
//
// `awsDeploy stage-probe host-role --probe kms|transactions --capture <file> ...` judges the output the operator saved
// from `gs-host role-probe` (infra/aws/single-host/host-role-probe.sh). It never calls AWS. The probe that ran is L6-6's
// task-role probe, UNCHANGED (the release image's own `stage-probe task-role`: iamProbe.ts, kmsProbe.ts,
// transactionProbe.ts), and every section is judged by L6-6's OWN judges -- there is no second implementation:
//
//   the principal   the IAM probe's AccessDenied answers name the caller: AWS itself must say
//                   `assumed-role/gs-<env>-host-app` for every forbidden shape (judgeIamProbe, the host role in the task
//                   role's place) -- and the wrapper's IMDS facts (that role's name, this instance) agree;
//   F5 (kms)        judgeKmsProbe: the three keys -- and the dedicated REMEDY key whenever the serving configuration names
//                   one (the record's required remedy_configured, held to the operator's `--remedy-key <ARN>|none`;
//                   Phase 3 escrow 2.1) -- opened through the production
//                   digest-only ECDSA_SHA_256 binding, their
//                   public keys = the configuration's (checkSignerIdentities), every disposable Sign verified against the
//                   CONFIGURED key and below the runtime's 3 000 ms bound; the transaction section NOT run (F5 writes
//                   nothing);
//   F6 (transactions) judgeTransactionProbe: T1-T4 on the disposable `L6CERT#<run>` partition only, read back empty.
//
// And the run itself: exactly one complete framed capture (a truncated one is NOT EVALUATED); the reviewed wrapper
// (its SHA-256 = the repository's, LF); the serving release (the digest = release.env's = the running container's), its
// build, this environment / generation / pool, this instance, no HOLD, no static credential, the server active, the
// probe container gone; the record reassembled from its SHA-256-chained lines, the task-role probe's own, not an ECS
// task's, made inside the wrapper's window.
//
// PASS / FAIL / NOT EVALUATED (exit 0 / 1 / 3). The record (`probe-host-role-<probe>-<run>.json`) and the verdict
// (`host-role-<probe>-<run>-verdict.json`, create-once: a retry is a new run id) are written to the evidence directory,
// each refused if anything in it looks secret.

import { createHash } from "crypto";

import type { Check } from "../deployVerify";
import { arr, checkEnvelope, disposablePartition, num, obj, PROBE_FORMAT, recordFromLog, secretFindings, stableStringify, str } from "./evidence";
import { IAM_PROBE_IDS, judgeIamProbe } from "./iamProbe";
import { BASE_KMS_PURPOSES, judgeKmsProbe } from "./kmsProbe";
import { judgeTransactionProbe } from "./transactionProbe";

export const HOST_ROLE_PROBE_BEGIN = "GS-HOST-ROLE-PROBE BEGIN";
export const HOST_ROLE_PROBE_END = /^GS-HOST-ROLE-PROBE END exit=(\d+)$/;
export const HOST_ROLE_PROBE_FORMAT = "18COSMOS/PHASE1-HOST-ROLE-PROBE/v1";
/** The reviewed wrapper (sent by gs-host role-probe), relative to the repository root. */
export const HOST_ROLE_WRAPPER = "infra/aws/single-host/host-role-probe.sh";

export const HOST_ROLE_PROBES = Object.freeze(["kms", "transactions"] as const);
export type HostRoleProbe = (typeof HOST_ROLE_PROBES)[number];

/** One file pair per probe AND run (a retry under a new run id lands beside the earlier verdict, never over it). */
export const HOST_ROLE_FILES = Object.freeze({
  record: (probe: HostRoleProbe, run: string) => `probe-host-role-${probe}-${run}.json`,
  verdict: (probe: HostRoleProbe, run: string) => `host-role-${probe}-${run}-verdict.json`,
});

/** The wrapper's SHA-256 as the host receives it (gs-host sends it LF-normalised). */
export const wrapperSha256 = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");

/** The single host's role (modules/single-host iam.tf `gs-<env>-host-app`). */
export const hostRoleName = (environment: string): string => `gs-${environment}-host-app`;

export type HostRoleVerdict = "PASS" | "FAIL" | "NOT EVALUATED";

export interface HostRoleExpect {
  readonly probe: HostRoleProbe;
  readonly run: string;
  readonly environment: string;
  readonly generation: number;
  readonly pool: string;
  readonly instanceId: string;
  readonly digest: string;
  readonly build: string;
  /** The repository's wrapper SHA-256 (LF); null when it could not be read (that check is then NOT EVALUATED). */
  readonly wrapperSha256: string | null;
  /** F5 only (Phase 3 escrow 2.1): the operator's fact of the serving configuration's dedicated REMEDY key -- its 12-hex
   *  fingerprint (from `--remedy-key <ARN>`), or null (`--remedy-key none`: no remedy key, timed money unavailable). The
   *  record's own coverage is held to it, so a record cannot skip REMEDY by saying none is configured. Absent on F5: FAIL. */
  readonly remedyKey?: string | null;
}

export interface HostRoleJudgement {
  readonly verdict: HostRoleVerdict;
  readonly checks: readonly Check[];
  /** The task-role probe's record, reassembled and SHA-256 checked; null when the capture holds none. */
  readonly record: unknown | null;
  readonly measurements: Record<string, unknown>;
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const unknown = (name: string, detail: string): Check => ({ name, status: "not-evaluated", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));

const CLOCK_SKEW_MS = 5_000;

/** Judge one saved `gs-host role-probe` capture (decoded text). Pure: no AWS, no file system. */
export function judgeHostRoleCapture(text: string, expect: HostRoleExpect): HostRoleJudgement {
  const L = `host-role probe (${expect.probe === "kms" ? "F5 KMS" : "F6 DynamoDB"})`;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const begins = lines.reduce<number[]>((acc, l, i) => (l === HOST_ROLE_PROBE_BEGIN ? [...acc, i] : acc), []);
  const ends = lines.reduce<number[]>((acc, l, i) => (HOST_ROLE_PROBE_END.test(l) ? [...acc, i] : acc), []);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    const why = begins.length === 0 ? "no run found (not a `gs-host role-probe` capture)" : ends.length === 0 ? "the run has no END line (truncated, or the command never finished)" : "more than one run, or an END before its BEGIN";
    return { verdict: "NOT EVALUATED", checks: [unknown(`${L}: one complete framed run`, why)], record: null, measurements: {} };
  }
  const body = lines.slice(begins[0] + 1, ends[0]);
  const exit = Number(HOST_ROLE_PROBE_END.exec(lines[ends[0]])?.[1]);
  const kv = new Map<string, string>();
  for (const l of body) {
    const m = /^([a-z][a-z0-9_]*)=(.*)$/.exec(l);
    if (m !== null && m[1] !== "probe_out" && !kv.has(m[1])) kv.set(m[1], m[2]);
  }
  const checks: Check[] = [pass(`${L}: one complete framed run`, `END exit=${exit}`)];
  const refused = kv.get("refused");
  if (refused !== undefined) checks.push(fail(`${L}: the host ran the probe`, `refused: ${refused}`));
  const fact = (name: string, key: string, want: string, why = ""): void => {
    const got = kv.get(key);
    checks.push(got === undefined ? unknown(`${L}: ${name}`, `no ${key} line${refused !== undefined ? " (refused before it)" : ""}`) : judge(`${L}: ${name}`, got === want, `${key}=${got}`, `${key}=${got}, not ${want}${why}`));
  };

  /* The run is the one asked for, by the reviewed wrapper. */
  fact("the probe asked for", "probe", expect.probe);
  fact("this run", "run_id", expect.run);
  fact("this deployment: environment", "environment", expect.environment);
  fact("this deployment: generation", "generation", String(expect.generation));
  fact("this deployment: pool", "pool", expect.pool);
  const ran = kv.get("wrapper_sha256");
  checks.push(
    expect.wrapperSha256 === null
      ? unknown(`${L}: the reviewed wrapper ran`, `the repository's ${HOST_ROLE_WRAPPER} could not be read to compare`)
      : ran === undefined
        ? unknown(`${L}: the reviewed wrapper ran`, "no wrapper_sha256 line")
        : judge(`${L}: the reviewed wrapper ran`, ran === expect.wrapperSha256, `sha256 ${ran}`, `the host ran a wrapper with sha256 ${ran}, not the repository's ${expect.wrapperSha256}`),
  );

  /* The SERVING release, on THIS host, under THE HOST ROLE. */
  fact("the release digest asked for", "digest", expect.digest);
  fact("release.env names that release", "release_digest", expect.digest, " (F5 / F6 probe the release the host SERVES)");
  fact("the running container is that release", "running_digest", expect.digest, " (F5 / F6 probe the release the host SERVES)");
  fact("its build", "build_id", expect.build);
  fact("the game server is serving", "server_state", "active");
  fact("no HOLD", "hold", "none");
  fact("no static AWS credential on the host", "static_credentials", "none", " (the instance role must be the only credential source)");
  fact("the single host", "instance_id", expect.instanceId);
  fact("the instance role", "instance_role", hostRoleName(expect.environment));
  const profile = kv.get("instance_profile");
  checks.push(profile === undefined ? unknown(`${L}: the instance profile`, "no instance_profile line") : judge(`${L}: the instance profile`, new RegExp(`^arn:aws[a-z-]*:iam::[0-9]{12}:instance-profile/${hostRoleName(expect.environment)}$`).test(profile), profile, `${profile} is not the host's profile ${hostRoleName(expect.environment)}`));
  const platform = kv.get("image_platform");
  checks.push(platform === undefined ? unknown(`${L}: the image's platform`, "no image_platform line") : judge(`${L}: the image's platform`, /^linux\/(arm64|amd64)$/.test(platform), platform, `${platform}`));
  fact("the probe exited cleanly", "probe_exit", "0");
  fact("the probe container is gone", "probe_container_left", "none");

  /* The task-role probe's own record. */
  const recordLines = body.filter((l) => l.startsWith("L6CERT/v1 "));
  let record: unknown | null = null;
  if (refused !== undefined) checks.push(unknown(`${L}: the probe's record`, "refused before the probe ran"));
  else {
    const got = recordFromLog(recordLines);
    if (!got.ok) checks.push(fail(`${L}: the probe's record`, `${got.problem} (the capture is complete -- END was reached -- so the record itself is missing or corrupt)`));
    else {
      record = got.record;
      checks.push(pass(`${L}: the probe's record`, `${recordLines.length} line(s), SHA-256 verified`));
    }
  }
  const measurements: Record<string, unknown> = { record_lines: recordLines.length };
  if (record !== null) {
    const r = obj(record);
    const findings = secretFindings(stableStringify(record), { ownRecord: true });
    checks.push(judge(`${L}: the record carries nothing secret`, findings.length === 0, "no secret-shaped material", findings.join(", ")));
    checks.push(...checkEnvelope(`${L}: record`, r, { probe: "task-role", run: expect.run, environment: expect.environment, generation: expect.generation, pool: expect.pool, notBefore: null }).filter((c) => !/: after the prerequisite$/.test(c.name)));
    const started = Date.parse(String(r.started_at));
    const finished = Date.parse(String(r.finished_at));
    const from = Date.parse(String(kv.get("probe_started_at")));
    const to = Date.parse(String(kv.get("probe_finished_at")));
    checks.push(
      judge(
        `${L}: the record was made inside the wrapper's run`,
        [started, finished, from, to].every(Number.isFinite) && started >= from - CLOCK_SKEW_MS && finished <= to + CLOCK_SKEW_MS && finished >= started,
        `${String(r.started_at)} .. ${String(r.finished_at)} within ${String(kv.get("probe_started_at"))} .. ${String(kv.get("probe_finished_at"))}`,
        `the record says ${String(r.started_at)} .. ${String(r.finished_at)}; the wrapper ran the probe ${String(kv.get("probe_started_at"))} .. ${String(kv.get("probe_finished_at"))}`,
      ),
    );
    const runner = obj(r.runner);
    checks.push(
      judge(
        `${L}: the host's probe, not an ECS task's`,
        runner.ecs_task === false && runner.task_arn === null && runner.build_id === expect.build && runner.runtime_parameter_matches_env === true,
        `no ECS task, BUILD_ID ${expect.build}, the host's own runtime document`,
        `ecs_task ${String(runner.ecs_task)}, task ${String(runner.task_arn)}, BUILD_ID ${String(runner.build_id)} (expected ${expect.build}), document matches ${String(runner.runtime_parameter_matches_env)}`,
      ),
    );
    const sections = obj(r.sections);
    const role = hostRoleName(expect.environment);
    /* The principal: AWS's own AccessDenied answers name the host role (and its DynamoDB IAM shape is the task's). */
    const iam = obj(sections.iam);
    checks.push(...(iam.status === "ran" ? judgeIamProbe(iam, role, IAM_PROBE_IDS).map((c) => ({ ...c, name: `${L}: ${c.name}` })) : [fail(`${L}: IAM (the principal)`, `not run (${String(iam.reason ?? "?")})`)]));
    const denials = arr(iam.results).map(obj).filter((x) => obj(x.answer).name === "AccessDeniedException");
    const principals = [...new Set(denials.map((x) => obj(obj(x.answer).principal).role).map(String))];
    checks.push(judge(`${L}: AWS names the host role as the caller`, denials.length >= 1 && principals.length === 1 && principals[0] === role, `${denials.length} AccessDenied answer(s), each for assumed-role/${role}`, denials.length === 0 ? "no AccessDenied answer names a caller" : `the denials name [${principals.join(", ")}], not ${role}`));
    measurements.iam_probes = arr(iam.results).length;
    if (expect.probe === "kms") {
      if (expect.remedyKey === undefined) checks.push(fail(`${L}: the operator's remedy-key fact`, "not given (--remedy-key <the remedy key ARN> | none): F5 never takes the record's own word for whether REMEDY was due"));
      const expected = expect.remedyKey === undefined ? undefined : { remedy: expect.remedyKey === null ? null : { key: expect.remedyKey } };
      checks.push(...judgeKmsProbe(sections.kms, expected).map((c) => ({ ...c, name: `${L}: ${c.name}` })));
      const t = obj(sections.transactions);
      checks.push(judge(`${L}: F5 wrote nothing`, t.status === "not-run" && t.partition === undefined, "the transaction probe did not run (no --disposable-writes)", `the transaction section is ${String(t.status)}${t.partition !== undefined ? ` on ${String(t.partition)}` : ""}`));
      const keys = obj(obj(obj(sections.kms).results).keys);
      for (const purpose of [...BASE_KMS_PURPOSES, ...("remedy" in keys ? ["remedy"] : [])]) {
        const ms = arr(obj(keys[purpose]).samples).map((x) => num(obj(x).ms)).filter((x): x is number => x !== null);
        measurements[`kms_${purpose}`] = ms.length === 0 ? null : { max_ms: Math.max(...ms), samples: ms.length, key: str(obj(keys[purpose]).key) };
      }
    } else {
      const t = obj(sections.transactions);
      checks.push(judge(`${L}: only the disposable partition`, t.partition === disposablePartition(expect.run), `${disposablePartition(expect.run)}`, `the probe names partition ${String(t.partition)}, not ${disposablePartition(expect.run)}`));
      checks.push(...judgeTransactionProbe(sections.transactions).map((c) => ({ ...c, name: `${L}: ${c.name}` })));
      const t3 = obj(obj(t.results).t3);
      measurements.t3 = { conflicts: t3.conflicts ?? null, applied: t3.applied ?? null };
      measurements.cleanup = obj(obj(t.results).cleanup).remaining ?? null;
    }
  }
  checks.push(exit === 0 ? pass(`${L}: exit status`, "0") : fail(`${L}: exit status`, `${exit}`));
  const verdict: HostRoleVerdict = checks.some((c) => c.status === "fail") ? "FAIL" : checks.every((c) => c.status === "pass") ? "PASS" : "NOT EVALUATED";
  return { verdict, checks, record, measurements };
}

/** The verdict record (create-once, beside the probe's record). */
export function hostRoleVerdictRecord(expect: HostRoleExpect, judged: HostRoleJudgement, extra: { readonly at: number; readonly captureSha256: string }): Record<string, unknown> {
  return {
    format: HOST_ROLE_PROBE_FORMAT,
    proof: expect.probe === "kms" ? "F5" : "F6",
    probe: expect.probe,
    run_id: expect.run,
    environment: expect.environment,
    generation: expect.generation,
    pool: expect.pool,
    instance_id: expect.instanceId,
    digest: expect.digest,
    build: expect.build,
    wrapper_sha256: expect.wrapperSha256,
    ...(expect.probe === "kms" ? { remedy_key: expect.remedyKey ?? null } : {}),
    capture_sha256: extra.captureSha256,
    at: new Date(extra.at).toISOString(),
    verdict: judged.verdict,
    measurements: judged.measurements,
    checks: judged.checks,
  };
}
