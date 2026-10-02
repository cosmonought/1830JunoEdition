// server/src/aws/deploy/migration/migrationCommands.ts
//
// COST-2B: `npm run awsDeploy -- migration-guard ...` -- OFFLINE. It reads files the operator captured and writes at most
// one record; it never calls AWS, never runs Terraform and never applies anything.
//
//   migration-guard <gate> --plan-evidence <dir> --environment <env> --app-account <12 digits>
//                   [--origin-domain <name>] [--generation 1] [--pool p1] [--retired-pools p2] [--record <file>]
//       <dir> is ONE stack's plan-evidence directory, captured WITH --keep-plan (`infra/aws/scripts/plan-evidence`
//       wrote it: version.json, plan-exitcode.txt, plan.json, run.json, stack.tfplan, stack.tfplan.sha256). Judged: the
//       plan's exit status (2: changes), Terraform >= 1.9 with hashicorp/aws 6.66.0, run.json naming the gate's stack,
//       the binary plan and plan.json bound to one capture by stack.tfplan.sha256, then the plan itself (`planGuards.ts`).
//       Exit 0: PASS -- with the owner's GO, apply EXACTLY that stack.tfplan (what was judged is what is applied;
//       Terraform refuses it if the state moved since); 1: FAIL (do NOT apply); 2: usage.
//
//   RECON-1A: app-read-authorize (step 7a) judges a TARGETED stacks/app plan -- run.json must record exactly its two
//   -target addresses (GATE_TARGETS; plan-evidence writes them) -- and needs --region and --ledger-table-arn;
//   ledger-operator-journal (step 7b) needs --ledger-table-arn. Every check prints PASS, FAIL or NOT EVALUATED (never a
//   bare SKIP for a check that could not be judged); the verdict is PASS only when EVERY check passed.
//
//   migration-guard nat --evidence <dir> [--min-quiet-hours 24] [--record <file>]
//       <dir> is `infra/aws/scripts/capture-nat-evidence`'s output (`natEvidence.ts`). PASS is evidence for the owner's
//       manual NAT deletion decision (step 23), never a deletion.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import type { Check } from "../deployVerify";
import { GATE_NAMES, GATE_TARGETS, GATES, isGateName, judgeMigrationPlan, MIGRATION_GUARD_FORMAT, STAGING_DEFAULTS, type GateName, type MigrationContext } from "./planGuards";
import { judgeNatEvidence, NAT_EVIDENCE_FORMAT, NAT_FILES, type NatEvidence, type NatFileKey } from "./natEvidence";

export const MIGRATION_USAGE = [
  "usage:",
  `  awsDeploy migration-guard (${GATE_NAMES.join(" | ")}) --plan-evidence <evidence>/terraform/<stack> --environment <env> --app-account <id> [--origin-domain <name>] [--region <r> --ledger-table-arn <ARN> --signing-keys <a,b,c>] [--commit <reviewed sha>] [--generation 1] [--pool p1] [--retired-pools p2] [--record <file>]`,
  "      edge-cutover needs --origin-domain; host-create needs --region, --ledger-table-arn and --signing-keys (the ledger stack's outputs).",
  "      app-read-authorize (step 7a, a TARGETED app plan) needs --region and --ledger-table-arn; ledger-operator-journal (step 7b) needs --ledger-table-arn.",
  "  awsDeploy migration-guard nat --evidence <dir> [--min-quiet-hours 24] [--record <file>]",
].join("\n");

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const TERRAFORM_MIN = [1, 9, 0];
const AWS_PROVIDER = "registry.terraform.io/hashicorp/aws";
const AWS_PROVIDER_VERSION = "6.66.0";

const FLAGS_WITH_VALUES = new Set(["--plan-evidence", "--environment", "--app-account", "--origin-domain", "--generation", "--pool", "--retired-pools", "--record", "--evidence", "--min-quiet-hours", "--region", "--ledger-table-arn", "--signing-keys", "--commit"]);

function parseFlags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!FLAGS_WITH_VALUES.has(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (out.has(flag)) throw new Error(`${flag} given twice`);
    out.set(flag, value);
    i += 1;
  }
  return out;
}

/** A file's text (a PowerShell UTF-8 BOM tolerated), or undefined. */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return undefined;
  }
}
function readJson(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const versionAtLeast = (v: string): boolean => {
  const parts = v.split(".").map((x) => parseInt(x, 10));
  if (parts.length < 3 || parts.some((x) => !Number.isInteger(x))) return false;
  for (let i = 0; i < 3; i += 1) if (parts[i] !== TERRAFORM_MIN[i]) return parts[i] > TERRAFORM_MIN[i];
  return true;
};

/** COST-2A's three-valued Check: a check that could not be judged prints NOT EVALUATED, never SKIP (it is not a pass:
 *  every verdict below is PASS only when every check passed). */
export const STATUS_WORD: Readonly<Record<Check["status"], string>> = Object.freeze({ pass: "PASS", fail: "FAIL", "not-evaluated": "NOT EVALUATED", skipped: "SKIP" });
export const line = (c: Check): string => `${STATUS_WORD[c.status] ?? "NOT EVALUATED"}  ${c.name}: ${c.detail}`;

function writeRecord(file: string | undefined, record: unknown, out: (line: string) => void): void {
  if (file === undefined) return;
  /* Create-once: a guard record is evidence and is never overwritten. */
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  out(`record written: ${file}`);
}

export function planEvidenceChecks(dir: string, gate: GateName, expectCommit?: string): { readonly checks: Check[]; readonly plan: unknown; readonly planSha256: string | null; readonly savedPlanSha256: string | null } {
  const checks: Check[] = [];
  const exit = (readText(path.join(dir, "plan-exitcode.txt")) ?? "").trim();
  checks.push(exit === "2" ? { name: "evidence: plan exit status", status: "pass", detail: "2 (changes planned)" } : { name: "evidence: plan exit status", status: "fail", detail: exit === "0" ? "0: the plan has no changes -- nothing for this step to apply (already applied, or the wrong configuration)" : `exit ${exit || "(missing)"} (1: the plan failed)` });
  const version = readJson(path.join(dir, "version.json")) as { terraform_version?: unknown; provider_selections?: Record<string, unknown> } | undefined;
  const tf = String(version?.terraform_version ?? "");
  const provider = version?.provider_selections?.[AWS_PROVIDER];
  const others = Object.keys(version?.provider_selections ?? {}).filter((k) => k !== AWS_PROVIDER);
  checks.push(others.length === 0 ? { name: "evidence: no other provider", status: "pass", detail: "hashicorp/aws is the only provider selected" } : { name: "evidence: no other provider", status: "fail", detail: `other providers selected: ${others.join(", ")} (external / null / local / http run code; the stacks use hashicorp/aws only)` });
  checks.push(versionAtLeast(tf) && provider === AWS_PROVIDER_VERSION ? { name: "evidence: Terraform and provider", status: "pass", detail: `Terraform ${tf}, hashicorp/aws ${AWS_PROVIDER_VERSION}` } : { name: "evidence: Terraform and provider", status: "fail", detail: `Terraform ${tf || "(unknown)"} (>= 1.9.0), hashicorp/aws ${String(provider ?? "(not selected)")} (${AWS_PROVIDER_VERSION} required)` });
  const run = readJson(path.join(dir, "run.json")) as { stack?: unknown; commit?: unknown; infra_aws_clean?: unknown; host_inputs_with_cr?: unknown } | undefined;
  /* RECON-1A (W-04): a checkout made before .gitattributes pinned the host's files LF keeps CRLF copies git calls clean. */
  const hostCr = Array.isArray(run?.host_inputs_with_cr) ? (run!.host_inputs_with_cr as unknown[]).map(String) : [];
  /* The module code a plan cannot show (cloud-init templates, host scripts) is the reviewed code only if the plan was made
     from a clean, committed checkout: plan-evidence records both. */
  const commit = typeof run?.commit === "string" ? run.commit : "";
  const commitOk = /^[0-9a-f]{40}$/.test(commit) && run?.infra_aws_clean === true && (expectCommit === undefined || commit === expectCommit);
  checks.push(
    commitOk
      ? { name: "evidence: planned from a clean, committed checkout", status: "pass", detail: `commit ${commit}, infra/aws clean${expectCommit === undefined ? " (pass --commit <sha> to require the reviewed one)" : " = --commit"}` }
      : {
          name: "evidence: planned from a clean, committed checkout",
          status: "fail",
          detail: !/^[0-9a-f]{40}$/.test(commit)
            ? "run.json names no commit (capture with this branch's plan-evidence, from a git checkout)"
            : hostCr.length > 0
              ? `the single host's embedded files carry CR on disk (${hostCr.slice(0, 4).join(", ")}${hostCr.length > 4 ? ", ..." : ""}): the user data would ship CRLF scripts / units -- re-clone, or \`git rm -r -q --cached infra/aws/modules/single-host\` then \`git reset -q --hard\`, and capture again`
              : run?.infra_aws_clean !== true ? `infra/aws was not clean at ${commit} (a modified, untracked or override file): the plan may not be the reviewed code's` : `planned from ${commit}, not --commit ${String(expectCommit)}`,
        },
  );
  checks.push(run?.stack === GATES[gate].stack ? { name: "evidence: the gate's stack", status: "pass", detail: `run.json names stacks/${GATES[gate].stack}` } : { name: "evidence: the gate's stack", status: "fail", detail: `run.json names ${String(run?.stack ?? "(missing)")}; ${gate} judges stacks/${GATES[gate].stack}` });
  /* RECON-1A: a gate that judges a TARGETED plan requires exactly its targets (an untargeted plan of the frozen app stack
     carries the desired-count drift and must never be the one applied here). */
  const wantTargets = GATE_TARGETS[gate];
  if (wantTargets !== undefined) {
    const got = (run as { targets?: unknown } | undefined)?.targets;
    const targets = Array.isArray(got) && got.every((t) => typeof t === "string") ? [...(got as string[])].sort() : null;
    const ok = targets !== null && targets.length === wantTargets.length && [...wantTargets].sort().every((t, i) => t === targets[i]);
    checks.push(
      ok
        ? { name: "evidence: the plan is targeted at exactly the step's resources", status: "pass", detail: `run.json targets ${wantTargets.join(", ")}` }
        : {
            name: "evidence: the plan is targeted at exactly the step's resources",
            status: "fail",
            detail:
              targets === null
                ? `run.json records no -target list (capture with this branch's plan-evidence, targeted: ${wantTargets.map((t) => `-target=${t}`).join(" ")})`
                : `run.json targets ${targets.length === 0 ? "nothing (an UNTARGETED plan)" : targets.join(", ")}; exactly ${wantTargets.join(", ")} required`,
          },
    );
  }
  const text = readText(path.join(dir, "plan.json"));
  let plan: unknown;
  try {
    plan = text === undefined ? undefined : JSON.parse(text);
  } catch {
    plan = undefined;
  }
  if (plan === undefined) checks.push({ name: "evidence: plan.json", status: "fail", detail: "missing or unreadable" });
  /* The binary plan this JSON was shown from (plan-evidence --keep-plan): the operator applies EXACTLY it, so what was
     judged is what is applied (Terraform refuses a saved plan whose state has moved since: "Saved plan is stale"). */
  const fileSha = (name: string): string | null => {
    try {
      return createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    } catch {
      return null;
    }
  };
  const savedPlanSha256 = fileSha(SAVED_PLAN);
  const planJsonSha256 = fileSha("plan.json");
  /* sha256sum's format ("<hash>  <name>", or "<hash> *<name>"): written by the SAME plan-evidence run as both files. */
  const recorded = new Map<string, string>();
  for (const l of (readText(path.join(dir, SAVED_PLAN_SHA)) ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(l.trim());
    if (m !== null) recorded.set(m[2], m[1]);
  }
  const bound = savedPlanSha256 !== null && planJsonSha256 !== null && recorded.get(SAVED_PLAN) === savedPlanSha256 && recorded.get("plan.json") === planJsonSha256;
  checks.push(
    bound
      ? { name: "evidence: the saved plan to apply", status: "pass", detail: `${SAVED_PLAN} (sha256 ${String(savedPlanSha256).slice(0, 16)}...) and this plan.json come from one capture: apply exactly that file` }
      : {
          name: "evidence: the saved plan to apply",
          status: "fail",
          detail:
            savedPlanSha256 === null
              ? `no ${SAVED_PLAN}: capture with plan-evidence --keep-plan (-KeepPlan), so the apply is exactly the judged plan`
              : `${SAVED_PLAN_SHA} does not bind ${SAVED_PLAN} and plan.json of one capture (a file replaced or edited after the capture?)`,
        },
  );
  return { checks, plan, planSha256: planJsonSha256, savedPlanSha256 };
}

/** plan-evidence --keep-plan: the binary plan and its SHA-256, beside plan.json. */
export const SAVED_PLAN = "stack.tfplan";
export const SAVED_PLAN_SHA = "stack.tfplan.sha256";

export async function migrationGuardCommand(argv: readonly string[], out: (line: string) => void): Promise<number> {
  const [gate, ...rest] = argv;
  let flags: Map<string, string>;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    out(`REFUSED: ${(error as Error).message}`);
    out(MIGRATION_USAGE);
    return EXIT_USAGE;
  }

  const recordFile = flags.get("--record");
  if (recordFile !== undefined && fs.existsSync(recordFile)) {
    out(`REFUSED: --record ${recordFile} already exists (a guard record is evidence: never overwritten)`);
    return EXIT_USAGE;
  }

  if (gate === "nat") {
    const dir = flags.get("--evidence");
    if (dir === undefined) {
      out(MIGRATION_USAGE);
      return EXIT_USAGE;
    }
    const minQuietHours = flags.has("--min-quiet-hours") ? Number(flags.get("--min-quiet-hours")) : 24;
    if (!Number.isInteger(minQuietHours) || minQuietHours < 24) {
      out("REFUSED: --min-quiet-hours is a whole number >= 24");
      return EXIT_USAGE;
    }
    const evidence = Object.fromEntries((Object.keys(NAT_FILES) as NatFileKey[]).map((k) => [k, readJson(path.join(dir, NAT_FILES[k]))])) as NatEvidence;
    const result = judgeNatEvidence(evidence, { minQuietHours });
    for (const c of result.checks) out(line(c));
    out(`COST-2B NAT DELETION EVIDENCE: ${result.verdict}${result.verdict === "PASS" ? " (evidence for the owner's decision; nothing was deleted)" : " -- DO NOT DELETE THE NAT GATEWAY"}`);
    writeRecord(flags.get("--record"), { format: NAT_EVIDENCE_FORMAT, kind: "nat-deletion-evidence", evidence_dir: dir, min_quiet_hours: minQuietHours, verdict: result.verdict, checks: result.checks }, out);
    return result.verdict === "PASS" ? EXIT_PASS : EXIT_FAIL;
  }

  if (gate === undefined || !isGateName(gate)) {
    out(MIGRATION_USAGE);
    return EXIT_USAGE;
  }
  const dir = flags.get("--plan-evidence");
  const environment = flags.get("--environment");
  const appAccountId = flags.get("--app-account");
  if (dir === undefined || environment === undefined || appAccountId === undefined) {
    out("REFUSED: --plan-evidence, --environment and --app-account are required");
    out(MIGRATION_USAGE);
    return EXIT_USAGE;
  }
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(environment) || !/^[0-9]{12}$/.test(appAccountId)) {
    out("REFUSED: --environment must match ^[a-z][a-z0-9-]{0,15}$ and --app-account be 12 digits");
    return EXIT_USAGE;
  }
  const generation = flags.has("--generation") ? Number(flags.get("--generation")) : STAGING_DEFAULTS.servingGeneration;
  const pool = flags.get("--pool") ?? STAGING_DEFAULTS.pool;
  const retiredPools = flags.has("--retired-pools") ? String(flags.get("--retired-pools")).split(",").filter((p) => p !== "") : [...STAGING_DEFAULTS.retiredPools];
  if (!Number.isInteger(generation) || generation < 1 || ![pool, ...retiredPools].every((p) => /^[a-z][a-z0-9-]{0,15}$/.test(p)) || retiredPools.includes(pool)) {
    out("REFUSED: --generation is a positive whole number; --pool / --retired-pools are distinct pool ids");
    return EXIT_USAGE;
  }
  if (gate === "edge-cutover" && flags.get("--origin-domain") === undefined) {
    out("REFUSED: edge-cutover needs --origin-domain (the host's origin_hostname; the ALB's name for the rollback)");
    return EXIT_USAGE;
  }
  const signingKeyArns = flags.has("--signing-keys") ? String(flags.get("--signing-keys")).split(",").filter((k) => k !== "") : undefined;
  if (gate === "host-create") {
    const region = flags.get("--region");
    const ledger = flags.get("--ledger-table-arn");
    if (region === undefined || ledger === undefined || signingKeyArns === undefined) {
      out("REFUSED: host-create needs --region <app region>, --ledger-table-arn <the ledger stack's table ARN> and --signing-keys <relayer,settlement,admission key ARNs> (from the ledger stack's outputs / the Juno document -- never from the plan)");
      return EXIT_USAGE;
    }
    if (!/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(region) || !/^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table\/[A-Za-z0-9_.-]+$/.test(ledger) || signingKeyArns.length !== 3 || new Set(signingKeyArns).size !== 3 || !signingKeyArns.every((k) => /^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key\/[0-9a-f-]{36}$/.test(k))) {
      out("REFUSED: --region, --ledger-table-arn (a DynamoDB table ARN) or --signing-keys (three distinct KMS key ARNs) malformed");
      return EXIT_USAGE;
    }
  }
  if (gate === "app-read-authorize" || gate === "ledger-operator-journal") {
    const region = flags.get("--region");
    const ledger = flags.get("--ledger-table-arn");
    if (ledger === undefined || (gate === "app-read-authorize" && region === undefined)) {
      out(`REFUSED: ${gate} needs ${gate === "app-read-authorize" ? "--region <app region> and " : ""}--ledger-table-arn <the ledger stack's ledger_table_arn> (the facts the grants name, never taken from the plan)`);
      return EXIT_USAGE;
    }
    if ((region !== undefined && !/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(region)) || !/^arn:aws:dynamodb:[a-z0-9-]+:[0-9]{12}:table\/[A-Za-z0-9_.-]+$/.test(ledger)) {
      out("REFUSED: --region or --ledger-table-arn (a DynamoDB table ARN) malformed");
      return EXIT_USAGE;
    }
  }
  const ctx: MigrationContext = { environment, appAccountId, servingGeneration: generation, pool, retiredPools, originDomain: flags.get("--origin-domain"), minEcrKeepImages: STAGING_DEFAULTS.minEcrKeepImages, region: flags.get("--region"), ledgerTableArn: flags.get("--ledger-table-arn"), signingKeyArns };

  const expectCommit = flags.get("--commit");
  if (expectCommit !== undefined && !/^[0-9a-f]{40}$/.test(expectCommit)) {
    out("REFUSED: --commit is a full 40-hex commit id");
    return EXIT_USAGE;
  }
  const evidence = planEvidenceChecks(dir, gate, expectCommit);
  const judged = evidence.plan === undefined ? null : judgeMigrationPlan(gate, evidence.plan, ctx);
  const checks = [...evidence.checks, ...(judged?.checks ?? [])];
  const verdict = checks.every((c) => c.status === "pass") && judged !== null ? "PASS" : "FAIL";
  out(`COST-2B migration guard: ${gate} (step ${GATES[gate].step}, stacks/${GATES[gate].stack})`);
  for (const c of checks) out(line(c));
  if (judged !== null) {
    out(`changes: ${judged.summary.changes.length === 0 ? "(none)" : ""}`);
    for (const c of judged.summary.changes) out(`  ${c}`);
  }
  out(
    `COST-2B MIGRATION GUARD ${gate}: ${verdict}${
      verdict === "PASS" ? ` (apply ONLY this saved plan, with the owner's GO: terraform -chdir=infra/aws/stacks/${GATES[gate].stack} apply ${path.join(dir, SAVED_PLAN)})` : " -- DO NOT APPLY"
    }`,
  );
  writeRecord(flags.get("--record"), { format: MIGRATION_GUARD_FORMAT, gate, stack: GATES[gate].stack, plan_sha256: evidence.planSha256, saved_plan_sha256: evidence.savedPlanSha256, context: ctx, verdict, checks, changes: judged?.summary.changes ?? [] }, out);
  return verdict === "PASS" ? EXIT_PASS : EXIT_FAIL;
}
