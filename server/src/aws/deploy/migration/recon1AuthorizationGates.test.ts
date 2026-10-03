// server/src/aws/deploy/migration/recon1AuthorizationGates.test.ts
//
// ==================================================================
//  RECON-1A: THE FROZEN-STACK AUTHORIZATION GATES (steps 7a / 7b) AND THE GUARD FIXTURE CROSS-PRODUCT (RECON-0 X-09)
// ==================================================================
//
// RECON-0 §F.1: COST-2A's host-verifier grants (bootstrap role) and JX-4C's evidence reads (operator role, app stack; and
// OperatorJournalQuery, ledger stack) were pending deltas the frozen app stack could not take by an ordinary apply (it
// would also correct the legacy desired-count drift and restart p1). Left pending, they would make every later untargeted
// guard refuse -- the rollback path included. RECON-1A installs them before step 8 through two dedicated, fail-closed gates:
//
//   app-read-authorize       a TARGETED stacks/app plan (run.json's -target list is exactly the two policies): the
//                            bootstrap policy gains exactly the four HostVerifier* statements, the operator policy exactly
//                            IdentityEvidenceRead and LedgerJournalQuery, each pinned to modules/app/iam.tf; nothing else.
//   ledger-operator-journal  the ledger's resource policy gains exactly OperatorJournalQuery, pinned to
//                            modules/ledger/main.tf; no key policy or other statement moves.
//
// Pinned here: the gates' statements against the module SOURCE (read EOL-normalised: W-02's pattern), the mutations a
// reviewer would try, the ordering against the later gates (a pending grant is refused there, naming 7a / 7b), RECON-0
// X-09's fixtures (the relayer rotation key, a JX-1K financial key set, JX-4C's statement and the host's coexistence
// together), the NOT EVALUATED print, and the runbook: no ordinary app-stack apply before compute-none, 7a / 7b before 8.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { execFileSync, spawnSync } from "child_process";

import type { Check } from "../deployVerify";
import { normalizeEol, readCheckoutText } from "../../../testSupport/portability";
import { appReadGrantStatements, BOOTSTRAP_READ_SIDS, GATE_NAMES, GATE_TARGETS, GATES, judgeMigrationPlan, ledgerJournalStatement, LEDGER_JOURNAL_SID, OPERATOR_READ_SIDS, type GateName, type MigrationContext } from "./planGuards";
import { line, migrationGuardCommand, SAVED_PLAN, SAVED_PLAN_SHA, STATUS_WORD } from "./migrationCommands";
import { bootstrapPolicy, FIXTURE, fixtureText, HOST_ROLE, ledgerResourcePolicy, operatorPolicy, resourceChange, TASK_ROLE, validPlans, X09_DIR, X09_GATES, x09Plans } from "./planFixtures";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const source = (rel: string): string => readCheckoutText(path.join(REPO, rel));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const CTX: MigrationContext = { environment: FIXTURE.environment, appAccountId: FIXTURE.appAccountId, servingGeneration: 1, pool: "p1", retiredPools: ["p2"], originDomain: FIXTURE.hostOrigin, minEcrKeepImages: 20, region: FIXTURE.region, ledgerTableArn: FIXTURE.ledgerTableArn, signingKeyArns: FIXTURE.signingKeyArns };
const PLANS = validPlans();
const plan = (gate: GateName): Obj => clone(PLANS[gate]) as Obj;
const A = "module.app";
const L = "module.ledger";
const BOOT = `${A}.aws_iam_role_policy.bootstrap`;
const OPER = `${A}.aws_iam_role_policy.operator[0]`;
const RP = `${L}.aws_dynamodb_resource_policy.ledger`;
const rc = (p: Obj, address: string): Obj => {
  const hit = (p.resource_changes as Obj[]).find((r) => r.address === address);
  assert.ok(hit, `the plan has ${address}`);
  return hit as Obj;
};
const judgeOf = (gate: GateName, p: unknown, ctx: MigrationContext = CTX) => judgeMigrationPlan(gate, p, ctx);
const failures = (r: ReturnType<typeof judgeOf>) => r.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`);
function passes(gate: GateName, p: unknown, ctx: MigrationContext = CTX): void {
  const r = judgeOf(gate, p, ctx);
  assert.equal(r.verdict, "PASS", failures(r).join("\n"));
}
function rejects(gate: GateName, p: unknown, why: RegExp, ctx: MigrationContext = CTX): void {
  const r = judgeOf(gate, p, ctx);
  assert.equal(r.verdict, "FAIL", `${gate} must refuse this plan`);
  const text = failures(r);
  assert.ok(text.some((t) => why.test(t)), `${gate}: a failure matching ${why} expected; got:\n  ${text.join("\n  ")}`);
}
/** Edit one statement of a policy (JSON text) in place. */
function editPolicy(change: Obj, side: "before" | "after", sid: string, f: (s: Obj, doc: Obj) => void): void {
  const doc = JSON.parse(change.change[side].policy);
  const st = doc.Statement.find((s: Obj) => s.Sid === sid);
  assert.ok(st, `statement ${sid}`);
  f(st, doc);
  change.change[side].policy = JSON.stringify(doc);
}

/* ------------------------------------------------------------------ */
/* Terraform source parity                                              */
/* ------------------------------------------------------------------ */

/** The `{ ... }` body starting at `open` (index of `{`), string- and interpolation-aware. */
function blockBody(text: string, open: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i += 1;
      else if (c === '"') quoted = false;
      else if (c === "$" && text[i + 1] === "{") {
        /* an interpolation inside a string: skip to its matching } */
        let d = 0;
        for (i += 1; i < text.length; i += 1) {
          if (text[i] === "{") d += 1;
          else if (text[i] === "}" && --d === 0) break;
        }
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "#") while (i < text.length && text[i] !== "\n") i += 1;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error("an unterminated block: the Terraform source cannot be bounded (fail closed)");
}
/** Every top-level `<keyword> {` block of a body (nested ones are inside their parents' bodies). */
function childBlocks(body: string, keyword: RegExp): string[] {
  const out: string[] = [];
  let i = 0;
  const re = new RegExp(`(^|\\n)\\s*${keyword.source}\\s*\\{`, "g");
  for (;;) {
    re.lastIndex = i;
    const m = re.exec(body);
    if (m === null) return out;
    const open = m.index + m[0].length - 1;
    const inner = blockBody(body, open);
    out.push(inner);
    i = open + inner.length + 2;
  }
}
/** The body with every nested block removed (its own attributes only). */
const ownAttributes = (body: string): string => {
  let out = body;
  for (const kw of [/principals/, /condition/, /content/, /dynamic\s+"statement"/]) for (const inner of childBlocks(out, kw)) out = out.replace(inner, "");
  return out;
};
/** A HCL list / string value, interpolated with `vars` (an unknown reference fails closed). */
function hclValues(raw: string, vars: Readonly<Record<string, string>>): string[] {
  const resolve = (expr: string): string => {
    const v = vars[expr.trim()];
    if (v === undefined) throw new Error(`unknown reference ${expr} in the module source (the parity table must name it)`);
    return v;
  };
  const items = raw.trim().startsWith("[") ? raw.trim().slice(1, -1).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/) : [raw];
  return items
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x) => (x.startsWith('"') ? x.slice(1, -1).replace(/\$\{([^}]+)\}/g, (_, e: string) => resolve(e)) : resolve(x)));
}
const attr = (body: string, name: string): string | undefined => new RegExp(`(?:^|\\n)\\s*${name}\\s*=\\s*(\\[[\\s\\S]*?\\]|"[^"\\n]*"|[A-Za-z_][\\w.\\[\\]]*)`).exec(body)?.[1];

/** One `data "aws_iam_policy_document" "<name>"` statement by Sid, as IAM JSON (normalised later by the guard's own rules). */
function moduleStatement(file: string, doc: string, sid: string, vars: Readonly<Record<string, string>>, text: string = source(file)): Obj {
  const head = new RegExp(`data\\s+"aws_iam_policy_document"\\s+"${doc}"\\s*\\{`).exec(text);
  assert.ok(head, `${file}: data "aws_iam_policy_document" "${doc}"`);
  const body = blockBody(text, head.index + head[0].length - 1);
  const statements = [...childBlocks(body, /statement/), ...childBlocks(body, /dynamic\s+"statement"/).flatMap((d) => childBlocks(d, /content/))];
  const hits = statements.filter((st) => attr(ownAttributes(st), "sid") === `"${sid}"`);
  assert.equal(hits.length, 1, `${file} ${doc}: exactly one statement ${sid}`);
  const st = hits[0];
  const own = ownAttributes(st);
  const out: Obj = { Sid: sid, Effect: (attr(own, "effect") ?? '"Allow"').slice(1, -1), Action: hclValues(attr(own, "actions")!, vars), Resource: hclValues(attr(own, "resources")!, vars) };
  for (const p of childBlocks(st, /principals/)) out.Principal = { [attr(p, "type")!.slice(1, -1)]: hclValues(attr(p, "identifiers")!, vars) };
  const conditions = childBlocks(st, /condition/);
  if (conditions.length > 0) {
    out.Condition = {};
    for (const c of conditions) {
      const testName = attr(c, "test")!.slice(1, -1);
      out.Condition[testName] = { ...(out.Condition[testName] ?? {}), [attr(c, "variable")!.slice(1, -1)]: hclValues(attr(c, "values")!, vars) };
    }
  }
  return out;
}

describe("RECON-1A: the gates' statements ARE the modules' (source parity, EOL-normalised)", () => {
  const E = FIXTURE.environment;
  const APP = FIXTURE.appAccountId;
  const vars: Record<string, string> = {
    "local.partition": "aws",
    "local.account": APP,
    "local.region": FIXTURE.region,
    "local.prefix": `gs-${E}`,
    "local.identity_table_arn": `arn:aws:dynamodb:${FIXTURE.region}:${APP}:table/gs-${E}-identity`,
    "var.ledger_table_arn": FIXTURE.ledgerTableArn,
    "aws_dynamodb_table.ledger.arn": FIXTURE.ledgerTableArn,
    "local.app_root": `arn:aws:iam::${APP}:root`,
    "local.operator_arn": `arn:aws:iam::${APP}:role/gs-${E}-operator`,
  };
  const grants = appReadGrantStatements(CTX)!;
  const sameStatement = (got: Obj, want: Obj): void => {
    const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(String).sort() : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, sort((v as Obj)[k])])) : v);
    assert.deepEqual(sort(got), sort(want));
  };
  for (const sid of BOOTSTRAP_READ_SIDS) {
    test(`bootstrap ${sid}: modules/app/iam.tf == the gate's pin`, () => {
      sameStatement(moduleStatement("infra/aws/modules/app/iam.tf", "bootstrap", sid, vars), grants.bootstrap.get(sid)!);
    });
  }
  for (const sid of OPERATOR_READ_SIDS) {
    test(`operator ${sid}: modules/app/iam.tf == the gate's pin`, () => {
      sameStatement(moduleStatement("infra/aws/modules/app/iam.tf", "operator", sid, vars), grants.operator.get(sid)!);
    });
  }
  test(`ledger ${LEDGER_JOURNAL_SID}: modules/ledger/main.tf == the gate's pin`, () => {
    sameStatement(moduleStatement("infra/aws/modules/ledger/main.tf", "ledger_resource", LEDGER_JOURNAL_SID, vars), ledgerJournalStatement(CTX)!);
  });
  test("the parser fails closed: a CRLF checkout (normalised, as readCheckoutText does) parses identically; an unterminated block throws", () => {
    const crlf = source("infra/aws/modules/app/iam.tf").replace(/\n/g, "\r\n");
    assert.ok(crlf.includes("\r\n"));
    for (const sid of OPERATOR_READ_SIDS) assert.deepEqual(moduleStatement("infra/aws/modules/app/iam.tf", "operator", sid, vars, normalizeEol(crlf)), moduleStatement("infra/aws/modules/app/iam.tf", "operator", sid, vars));
    const head = /data\s+"aws_iam_policy_document"\s+"operator"\s*\{/.exec(crlf)!;
    assert.throws(() => blockBody(crlf.slice(0, head.index + head[0].length + 40), head.index + head[0].length - 1), /cannot be bounded/);
    assert.throws(() => moduleStatement("infra/aws/modules/app/iam.tf", "operator", "NoSuchStatement", vars), /exactly one statement NoSuchStatement/);
  });
});

/* ------------------------------------------------------------------ */
/* Gate 7a: app-read-authorize                                          */
/* ------------------------------------------------------------------ */

describe("RECON-1A app-read-authorize (step 7a): exactly the pending read grants, from a targeted plan", () => {
  test("the valid targeted plan PASSES; a re-run after a partial apply (one policy already final) PASSES", () => {
    passes("app-read-authorize", plan("app-read-authorize"));
    const rerun = plan("app-read-authorize");
    Object.assign(rc(rerun, BOOT).change, { actions: ["no-op"], before: rc(rerun, BOOT).change.after });
    passes("app-read-authorize", rerun);
    const done = plan("app-read-authorize");
    for (const a of [BOOT, OPER]) Object.assign(rc(done, a).change, { actions: ["no-op"], before: rc(done, a).change.after });
    rejects("app-read-authorize", done, /nothing for this step to apply/);
  });

  test("the facts are the operator's: no --region / --ledger-table-arn, or a plan naming another ledger, FAILS", () => {
    rejects("app-read-authorize", plan("app-read-authorize"), /--region <app region> and --ledger-table-arn/, { ...CTX, region: undefined });
    rejects("app-read-authorize", plan("app-read-authorize"), /--region <app region> and --ledger-table-arn/, { ...CTX, ledgerTableArn: undefined });
    const other = "arn:aws:dynamodb:us-east-1:333333333333:table/gs-staging-ledger";
    const p = plan("app-read-authorize");
    p.variables.ledger_table_arn = { value: other };
    editPolicy(rc(p, OPER), "after", "LedgerJournalQuery", (s) => (s.Resource = other));
    rejects("app-read-authorize", p, /LedgerJournalQuery/);
    rejects("app-read-authorize", p, /ledger_table_arn = .*333333333333/);
  });

  test("a statement widened, narrowed or re-pointed is refused, by name", () => {
    const cases: Array<[string, string, (s: Obj) => void, RegExp]> = [
      [BOOT, "HostVerifierEcsEra", (s) => (s.Action = ["ecs:DescribeClusters", "ecs:ListServices", "ecs:UpdateService"]), /differ from the module's rendering: HostVerifierEcsEra/],
      [BOOT, "HostVerifierHostRole", (s) => (s.Resource = [`arn:aws:iam::${FIXTURE.appAccountId}:role/*`]), /HostVerifierHostRole \(WIDENED by a wildcard: arn:aws:iam::111111111111:role\/\*\)/],
      [BOOT, "HostVerifierDescribeUnscopable", (s) => s.Action.push("ec2:*"), /HostVerifierDescribeUnscopable \(WIDENED by a wildcard: ec2:\*\)/],
      [BOOT, "HostVerifierBudgets", (s) => (s.Action = ["budgets:*"]), /HostVerifierBudgets \(WIDENED/],
      [BOOT, "HostVerifierDescribeUnscopable", (s) => (s.Effect = "Deny"), /HostVerifierDescribeUnscopable/],
      [OPER, "IdentityEvidenceRead", (s) => delete s.Condition["ForAllValues:StringLike"], /IdentityEvidenceRead/],
      [OPER, "IdentityEvidenceRead", (s) => delete s.Condition.Null, /IdentityEvidenceRead/],
      [OPER, "IdentityEvidenceRead", (s) => s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"].push("SESS#*"), /IdentityEvidenceRead/],
      [OPER, "IdentityEvidenceRead", (s) => s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"].push("LINK#*"), /IdentityEvidenceRead/],
      [OPER, "IdentityEvidenceRead", (s) => (s.Action = ["dynamodb:GetItem", "dynamodb:Query"]), /IdentityEvidenceRead/],
      [OPER, "IdentityEvidenceRead", (s) => (s.Resource = "arn:aws:dynamodb:us-east-1:111111111111:table/*"), /IdentityEvidenceRead \(WIDENED by a wildcard/],
      [OPER, "LedgerJournalQuery", (s) => (s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] = "*"), /LedgerJournalQuery \(WIDENED by a wildcard: \*\)|LedgerJournalQuery/],
      [OPER, "LedgerJournalQuery", (s) => (s.Action = ["dynamodb:Query", "dynamodb:Scan"]), /LedgerJournalQuery/],
    ];
    for (const [address, sid, f, why] of cases) {
      const p = plan("app-read-authorize");
      editPolicy(rc(p, address), "after", sid, f);
      rejects("app-read-authorize", p, why);
    }
  });

  test("anything else of either policy moving, or an extra statement, is refused", () => {
    const widened = plan("app-read-authorize");
    editPolicy(rc(widened, OPER), "after", "LedgerRead", (s) => (s.Action = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:PutItem"]));
    rejects("app-read-authorize", widened, /existing statements change: LedgerRead/);
    const extra = plan("app-read-authorize");
    editPolicy(rc(extra, BOOT), "after", "HostVerifierBudgets", (_s, doc) => doc.Statement.push({ Sid: "HostVerifierRunCommand", Effect: "Allow", Action: "ssm:SendCommand", Resource: "*" }));
    rejects("app-read-authorize", extra, /statements this step does not add: HostVerifierRunCommand/);
    const removed = plan("app-read-authorize");
    editPolicy(rc(removed, BOOT), "after", "VerifierDescribeServices", (_s, doc) => (doc.Statement = doc.Statement.filter((s: Obj) => s.Sid !== "VerifierDescribeServices")));
    rejects("app-read-authorize", removed, /statements removed: VerifierDescribeServices/);
    const missing = plan("app-read-authorize");
    editPolicy(rc(missing, OPER), "after", "LedgerJournalQuery", (_s, doc) => (doc.Statement = doc.Statement.filter((s: Obj) => s.Sid !== "LedgerJournalQuery")));
    rejects("app-read-authorize", missing, /statements missing after the change: LedgerJournalQuery/);
    const partial = plan("app-read-authorize");
    editPolicy(rc(partial, BOOT), "before", "VerifierDescribeServices", (_s, doc) => doc.Statement.push(JSON.parse(rc(partial, BOOT).change.after.policy).Statement.find((s: Obj) => s.Sid === "HostVerifierEcsEra")));
    rejects("app-read-authorize", partial, /already holds HostVerifierEcsEra but not/);
    const unknown = plan("app-read-authorize");
    rc(unknown, OPER).change.after.policy = null;
    rc(unknown, OPER).change.after_unknown = { policy: true };
    rejects("app-read-authorize", unknown, /policy unknown until apply/);
    const attrs = plan("app-read-authorize");
    rc(attrs, BOOT).change.after.name = "gs-bootstrap-wide";
    rejects("app-read-authorize", attrs, /also changes name/);
    const replaced = plan("app-read-authorize");
    Object.assign(rc(replaced, OPER).change, { actions: ["delete", "create"] });
    rejects("app-read-authorize", replaced, /DESTROYED \/ REPLACED is absolutely forbidden/);
    const gone = plan("app-read-authorize");
    gone.resource_changes = (gone.resource_changes as Obj[]).filter((r) => r.address !== OPER);
    rejects("app-read-authorize", gone, /the operator policy is not in the plan/);
  });

  test("ECS (the desired-count drift), task definitions, the cluster, tables, documents, roles: all refused", () => {
    const ecs = (type: string, name: string, index: string | number | undefined, before: Obj, after: Obj): Obj => resourceChange({ module: A, type, name, index, actions: ["update"], before, after });
    const mutations: Array<[Obj, RegExp]> = [
      [ecs("aws_ecs_service", "pool", "p1", { desired_count: 0 }, { desired_count: 1 }), /would RESTART module\.app\.aws_ecs_service\.pool\["p1"\]/],
      [ecs("aws_ecs_task_definition", "pool", "p1", { revision: 7 }, { revision: 8 }), /ECS untouched/],
      [ecs("aws_ecs_cluster", "this", 0, { setting: [] }, { setting: [{ name: "containerInsights", value: "enabled" }] }), /ECS untouched/],
      [ecs("aws_dynamodb_table", "identity", undefined, { name: "gs-staging-identity" }, { name: "gs-staging-identity", deletion_protection_enabled: false }), /no table, document, key, edge or other IAM change/],
      [ecs("aws_ssm_parameter", "runtime", "p1", { insecure_value: "a" }, { insecure_value: "b" }), /no table, document, key, edge or other IAM change/],
      [ecs("aws_iam_role", "bootstrap", undefined, { assume_role_policy: "{}" }, { assume_role_policy: '{"Statement":[{"Principal":{"AWS":"*"}}]}' }), /aws_iam_role\.bootstrap \[update\]: NOT PART OF THIS STEP/],
      [ecs("aws_iam_role_policy", "recovery", 0, { policy: "{}" }, { policy: "{}" }), /no table, document, key, edge or other IAM change/],
      [ecs("aws_cloudfront_distribution", "site", 0, { enabled: true }, { enabled: false }), /NOT PART OF THIS STEP/],
    ];
    for (const [entry, why] of mutations) {
      const p = plan("app-read-authorize");
      (p.resource_changes as Obj[]).push(entry);
      rejects("app-read-authorize", p, why);
      rejects("app-read-authorize", p, /every change is one this step makes/);
    }
    const compute = plan("app-read-authorize");
    compute.variables.compute = { value: "none" };
    rejects("app-read-authorize", compute, /still ecs/);
    const glass = plan("app-read-authorize");
    glass.variables.recovery_break_glass = { value: true };
    rejects("app-read-authorize", glass, /recovery_break_glass = true/);
  });

  test("an UNTARGETED app plan (the drift + the grants: COST-2A's old D0) is refused, at the plan and at the evidence", () => {
    /* the ordinary apply D0 would have made: every ECS-era object planned, the drift corrected, the grants added */
    const d0 = plan("ecs-rollback");
    for (const r of d0.resource_changes as Obj[]) if (r.type === "aws_ecs_service") Object.assign(r.change, { actions: ["update"], before: { ...r.change.before, desired_count: 0 }, after: { ...r.change.before, desired_count: 1 } });
    for (const a of [BOOT, OPER]) {
      const policy = rc(d0, a);
      Object.assign(policy.change, { actions: ["update"], before: rc(plan("app-read-authorize"), a).change.before, after: rc(plan("app-read-authorize"), a).change.after });
    }
    rejects("app-read-authorize", d0, /would RESTART module\.app\.aws_ecs_service\.pool\["p1"\]/);
    rejects("app-read-authorize", d0, /aws_ecs_service\.pool\["p2"\] \[update\]: NOT PART OF THIS STEP/);
  });
});

/* ------------------------------------------------------------------ */
/* Gate 7b: ledger-operator-journal                                     */
/* ------------------------------------------------------------------ */

describe("RECON-1A ledger-operator-journal (step 7b): exactly OperatorJournalQuery", () => {
  test("the valid plan PASSES; X-09's (rotation key + a financial set) PASSES; nothing to add FAILS", () => {
    passes("ledger-operator-journal", plan("ledger-operator-journal"));
    passes("ledger-operator-journal", clone(x09Plans()["ledger-operator-journal"]));
    const done = plan("ledger-operator-journal");
    Object.assign(rc(done, RP).change, { actions: ["no-op"], before: rc(done, RP).change.after });
    rejects("ledger-operator-journal", done, /already in the policy: nothing for this step to apply/);
    rejects("ledger-operator-journal", plan("ledger-operator-journal"), /--ledger-table-arn/, { ...CTX, ledgerTableArn: undefined });
  });

  test("the statement re-pointed, widened or loosened is refused", () => {
    const cases: Array<[(s: Obj) => void, RegExp]> = [
      [(s) => (s.Condition.ArnEquals["aws:PrincipalArn"] = `arn:aws:iam::${FIXTURE.appAccountId}:role/gs-staging-bootstrap`), /OperatorJournalQuery/],
      [(s) => (s.Condition.ArnEquals["aws:PrincipalArn"] = [`arn:aws:iam::${FIXTURE.appAccountId}:role/gs-staging-operator`, HOST_ROLE]), /OperatorJournalQuery/],
      [(s) => (s.Principal = { AWS: "*" }), /OperatorJournalQuery \(WIDENED|OperatorJournalQuery/],
      [(s) => (s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] = "*"), /OperatorJournalQuery/],
      [(s) => delete s.Condition.Null, /OperatorJournalQuery/],
      [(s) => delete s.Condition.ArnEquals, /OperatorJournalQuery/],
      [(s) => (s.Action = ["dynamodb:Query", "dynamodb:Scan"]), /OperatorJournalQuery/],
      [(s) => (s.Action = "dynamodb:*"), /OperatorJournalQuery \(WIDENED by a wildcard: dynamodb:\*\)/],
      [(s) => (s.Resource = "*"), /OperatorJournalQuery \(WIDENED by a wildcard: \*\)/],
    ];
    for (const [f, why] of cases) {
      const p = plan("ledger-operator-journal");
      editPolicy(rc(p, RP), "after", "OperatorJournalQuery", f);
      rejects("ledger-operator-journal", p, why);
    }
  });

  test("the host role riding along (step 8's change), a key policy, the table, backups, another statement: refused", () => {
    const host = plan("ledger-operator-journal");
    rc(host, RP).change.after.policy = ledgerResourcePolicy([TASK_ROLE, HOST_ROLE]);
    rejects("ledger-operator-journal", host, /existing statements change: AppTaskLedgerRead, AppTaskLedgerPutNeverAppgen/);
    const key = plan("ledger-operator-journal");
    const k = rc(key, `${L}.aws_kms_key.signing["relayer"]`);
    Object.assign(k.change, { actions: ["update"], after: { ...k.change.before, policy: String(k.change.before.policy).replace(TASK_ROLE, HOST_ROLE) } });
    rejects("ledger-operator-journal", key, /KMS: no key or key-policy change/);
    const x09key = clone(x09Plans()["ledger-operator-journal"]) as Obj;
    const r2 = rc(x09key, `${L}.aws_kms_key.signing["relayer-r2"]`);
    Object.assign(r2.change, { actions: ["update"], after: { ...r2.change.before, policy: String(r2.change.before.policy).replace(TASK_ROLE, HOST_ROLE) } });
    rejects("ledger-operator-journal", x09key, /KMS: no key or key-policy change/);
    const table = plan("ledger-operator-journal");
    Object.assign(rc(table, `${L}.aws_dynamodb_table.ledger`).change, { actions: ["delete", "create"] });
    rejects("ledger-operator-journal", table, /the ledger table: never replaced/);
    const backup = plan("ledger-operator-journal");
    Object.assign(rc(backup, `${L}.aws_backup_vault_lock_configuration.ledger`).change, { actions: ["delete"], after: null });
    rejects("ledger-operator-journal", backup, /AWS Backup: untouched/);
    const extra = plan("ledger-operator-journal");
    editPolicy(rc(extra, RP), "after", "OperatorJournalQuery", (_s, doc) => doc.Statement.push({ Sid: "OperatorLedgerWrite", Effect: "Allow", Action: "dynamodb:PutItem", Resource: FIXTURE.ledgerTableArn, Principal: { AWS: `arn:aws:iam::${FIXTURE.appAccountId}:root` } }));
    rejects("ledger-operator-journal", extra, /statements this step does not add: OperatorLedgerWrite/);
    const elsewhere = plan("ledger-operator-journal");
    rc(elsewhere, RP).change.after.resource_arn = "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-other";
    rejects("ledger-operator-journal", elsewhere, /also changes resource_arn|not --ledger-table-arn/);
  });
});

/* ------------------------------------------------------------------ */
/* Ordering: the later gates see no foreign delta -- and name 7a / 7b   */
/* ------------------------------------------------------------------ */

describe("RECON-1A ordering: a grant still pending is refused by every later gate, which names the step", () => {
  test("ledger-host-authorize / ledger-task-deauthorize refuse a plan still adding OperatorJournalQuery (run 7b first)", () => {
    for (const gate of ["ledger-host-authorize", "ledger-task-deauthorize"] as const) {
      const p = plan(gate);
      const before = rc(p, RP).change.before;
      const doc = JSON.parse(before.policy);
      doc.Statement = doc.Statement.filter((s: Obj) => s.Sid !== "OperatorJournalQuery");
      before.policy = JSON.stringify(doc);
      rejects(gate, p, /OperatorJournalQuery still pending: run step 7b \(migration-guard ledger-operator-journal\) first/);
    }
  });
  test("compute-none and ecs-rollback refuse a plan still carrying the app read grants (run 7a first; never an ordinary apply)", () => {
    const td = plan("compute-none");
    rc(td, BOOT).change.before.policy = bootstrapPolicy(["p1", "p2"], false);
    rejects("compute-none", td, /HostVerifierDescribeUnscopable, HostVerifierEcsEra, HostVerifierHostRole, HostVerifierBudgets still pending: run step 7a/);
    const op = plan("compute-none");
    rc(op, OPER).change.before.policy = operatorPolicy(["p1", "p2"], false);
    rejects("compute-none", op, /IdentityEvidenceRead, LedgerJournalQuery still pending: run step 7a .*never an ordinary app-stack apply/);
    const rb = plan("ecs-rollback");
    Object.assign(rc(rb, OPER).change, { actions: ["update"], before: { ...rc(rb, OPER).change.before, policy: operatorPolicy(["p1", "p2"], false) } });
    rejects("ecs-rollback", rb, /aws_iam_role_policy\.operator\[0\] \[update\]: NOT PART OF THIS STEP.*still pending: run step 7a/);
    const cut = plan("edge-cutover");
    (cut.resource_changes as Obj[]).push(clone(rc(plan("app-read-authorize"), BOOT)));
    rejects("edge-cutover", cut, /aws_iam_role_policy\.bootstrap \[update\]: NOT PART OF THIS STEP.*still pending: run step 7a/);
  });
  test("after 7a / 7b the later gates accept the FINAL prior state (the grants present, untouched)", () => {
    for (const gate of ["ledger-host-authorize", "edge-cutover", "ecs-rollback", "compute-none", "ledger-task-deauthorize"] as const) {
      const p = plan(gate);
      const policies = (p.prior_state.values.root_module.child_modules[0].resources as Obj[]).map((r) => String(r.values.policy ?? ""));
      if (gate.startsWith("ledger")) assert.ok(policies.some((t) => t.includes('"Sid":"OperatorJournalQuery"')), `${gate}: the prior state holds OperatorJournalQuery`);
      else for (const sid of [...BOOTSTRAP_READ_SIDS, ...OPERATOR_READ_SIDS]) assert.ok(policies.some((t) => t.includes(`"Sid":"${sid}"`)), `${gate}: the prior state holds ${sid}`);
      passes(gate, p);
    }
  });
});

/* ------------------------------------------------------------------ */
/* X-09: the ledger guards over the full key set                         */
/* ------------------------------------------------------------------ */

describe("RECON-0 X-09: rotation key x JX-1K financial set x JX-4C x the host's coexistence", () => {
  const X = x09Plans();
  for (const [name, p] of Object.entries(X)) {
    test(`${X09_DIR}/${name}.json is the builder's`, () => {
      assert.equal(source(`${X09_DIR}/${name}.json`), fixtureText(p as Obj), "regenerate: node dist/server/src/aws/deploy/migration/planFixtures.js --write");
    });
    test(`x09 ${name} PASSES its gate and NO other`, () => {
      const gate = X09_GATES[name];
      passes(gate, clone(p));
      for (const other of GATE_NAMES.filter((g) => g !== gate)) assert.equal(judgeOf(other, clone(p)).verdict, "FAIL", other);
    });
  }
  test("no other x09 fixture file", () => {
    assert.deepEqual(fs.readdirSync(path.join(REPO, X09_DIR)).sort(), Object.keys(X).map((n) => `${n}.json`).sort());
  });
  test("every key of the state -- relayer-r2 and the financial pair included -- must move with the host", () => {
    const keys = (X["ledger-host-authorize"] as Obj).resource_changes.filter((r: Obj) => r.type === "aws_kms_key").map((r: Obj) => r.index);
    assert.deepEqual([...keys].sort(), ["admission", "admission-v2", "relayer", "relayer-r2", "settlement", "settlement-v2"]);
    for (const left of ["relayer-r2", "settlement-v2", "admission-v2"]) {
      const p = clone(X["ledger-host-authorize"]) as Obj;
      p.resource_changes = p.resource_changes.filter((r: Obj) => r.address !== `${L}.aws_kms_key.signing["${left}"]`);
      rejects("ledger-host-authorize", p, new RegExp(`signing\\["${left}"\\] \\[not in the plan\\]`));
      const q = clone(X["ledger-task-deauthorize"]) as Obj;
      Object.assign(rc(q, `${L}.aws_kms_key.signing["${left}"]`).change, { actions: ["no-op"], after: rc(q, `${L}.aws_kms_key.signing["${left}"]`).change.before });
      rejects("ledger-task-deauthorize", q, /every signing key's policy changes with it/);
    }
    const created = clone(X["ledger-host-authorize"]) as Obj;
    const c = rc(created, `${L}.aws_kms_key.signing["settlement-v2"]`);
    Object.assign(c.change, { actions: ["delete", "create"] });
    rejects("ledger-host-authorize", created, /KMS: no key created, destroyed or replaced/);
  });
  test("the rotation proof's BootstrapRelayerFenceRead and JX-4C's statement stay byte-equal through steps 8 and 22", () => {
    for (const gate of ["ledger-host-authorize", "ledger-task-deauthorize"] as const) {
      for (const sid of ["BootstrapRelayerFenceRead", "OperatorJournalQuery"]) {
        const p = clone(X[gate]) as Obj;
        editPolicy(rc(p, RP), "after", sid, (s) => (s.Action = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query"]));
        rejects(gate, p, new RegExp(`statement ${sid} (is not a runtime statement|does not name)`));
      }
    }
  });
});

describe("RECON-1A: plans Terraform itself produced (terraform-real/, moto-backed) pass their gate, and only it", () => {
  const REAL_LEDGER = "arn:aws:dynamodb:us-east-1:123456789012:table/gs-staging-ledger";
  const REAL: ReadonlyArray<[string, GateName, MigrationContext]> = [
    ["app-read-authorize", "app-read-authorize", { ...CTX, appAccountId: "123456789012", region: "us-east-1", ledgerTableArn: FIXTURE.ledgerTableArn }],
    ["ledger-operator-journal", "ledger-operator-journal", { ...CTX, ledgerTableArn: REAL_LEDGER }],
    ["x09-ledger-host-authorize", "ledger-host-authorize", { ...CTX, ledgerTableArn: REAL_LEDGER }],
    ["x09-ledger-task-deauthorize", "ledger-task-deauthorize", { ...CTX, ledgerTableArn: REAL_LEDGER }],
  ];
  const real = (name: string): Obj => JSON.parse(source(`infra/aws/fixtures/migration-plans/terraform-real/${name}.json`)) as Obj;
  for (const [name, gate, ctx] of REAL) {
    test(`real ${name} PASSES ${gate}, and every other gate refuses it`, () => {
      passes(gate, real(name), ctx);
      for (const other of GATE_NAMES.filter((g) => g !== gate)) assert.equal(judgeOf(other, real(name), ctx).verdict, "FAIL", other);
    });
  }
  test("the real targeted 7a plan is exactly the two policies and their two roles", () => {
    assert.deepEqual((real("app-read-authorize").resource_changes as Obj[]).map((r) => `${r.address} ${r.change.actions.join(",")}`).sort(), [
      "module.app.aws_iam_role.bootstrap no-op",
      "module.app.aws_iam_role.operator[0] no-op",
      "module.app.aws_iam_role_policy.bootstrap update",
      "module.app.aws_iam_role_policy.operator[0] update",
    ]);
  });
  test("the real X-09 ledger plans carry six keys (relayer-r2 and the financial pair v2), each moved with the host", () => {
    for (const name of ["x09-ledger-host-authorize", "x09-ledger-task-deauthorize"]) {
      const keys = (real(name).resource_changes as Obj[]).filter((r) => r.type === "aws_kms_key");
      assert.deepEqual(keys.map((r) => String(r.index)).sort(), ["admission", "admission-v2", "relayer", "relayer-r2", "settlement", "settlement-v2"]);
      assert.ok(keys.every((r) => r.change.actions.join() === "update"), name);
    }
    assert.ok((real("ledger-operator-journal").resource_changes as Obj[]).filter((r) => r.type === "aws_kms_key").every((r) => r.change.actions.join() === "no-op"));
  });
  test("mutations of the real plans are refused", () => {
    const ctx = REAL[0][2];
    const w = real("app-read-authorize");
    editPolicy(rc(w, OPER), "after", "IdentityEvidenceRead", (s) => (s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] = ["PRIN#*", "PROF#*", "FAM#*", "SESS#*"]));
    rejects("app-read-authorize", w, /IdentityEvidenceRead/, ctx);
    const b = real("app-read-authorize");
    editPolicy(rc(b, BOOT), "after", "HostVerifierHostRole", (s) => (s.Resource = "*"));
    rejects("app-read-authorize", b, /HostVerifierHostRole \(WIDENED by a wildcard: \*\)/, ctx);
    const j = real("ledger-operator-journal");
    editPolicy(rc(j, RP), "after", "OperatorJournalQuery", (s) => (s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] = "*"));
    rejects("ledger-operator-journal", j, /OperatorJournalQuery/, REAL[1][2]);
  });
});

/* ------------------------------------------------------------------ */
/* NOT EVALUATED; the command                                           */
/* ------------------------------------------------------------------ */

describe("RECON-1A: the migration output prints NOT EVALUATED (never SKIP) and the verdict stays every-PASS", () => {
  test("the four statuses print as their words", () => {
    const c = (status: Check["status"]): Check => ({ name: "x", status, detail: "d" });
    assert.equal(line(c("pass")), "PASS  x: d");
    assert.equal(line(c("fail")), "FAIL  x: d");
    assert.equal(line(c("not-evaluated")), "NOT EVALUATED  x: d");
    assert.equal(STATUS_WORD["not-evaluated"], "NOT EVALUATED");
    assert.doesNotMatch(source("server/src/aws/deploy/migration/migrationCommands.ts"), /: "SKIP"\}  \$\{c\.name\}/);
    assert.match(source("server/src/aws/deploy/migration/migrationCommands.ts"), /checks\.every\(\(c\) => c\.status === "pass"\)/);
    assert.match(source("server/src/aws/deploy/migration/planGuards.ts"), /verdict: checks\.every\(\(c\) => c\.status === "pass"\) \? "PASS" : "FAIL"/);
  });
});

describe("RECON-1A: the command -- the targets, the facts", () => {
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  function evidence(gate: GateName, targets: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon1-"));
    const planText = JSON.stringify(PLANS[gate]);
    fs.writeFileSync(path.join(dir, "plan.json"), planText);
    fs.writeFileSync(path.join(dir, "plan-exitcode.txt"), "2\n");
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ terraform_version: "1.9.8", provider_selections: { "registry.terraform.io/hashicorp/aws": "6.66.0" } }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ format: "18COSMOS/L6-6-PLAN/v1", run_id: "recon1-test", stack: GATES[gate].stack, commit: "ee14050f18ba4a51b5af73a5ea9a9a6e89674073", infra_aws_clean: true, ...(targets === undefined ? {} : { targets }) }));
    const binary = Buffer.from(`binary plan for ${gate}`);
    fs.writeFileSync(path.join(dir, SAVED_PLAN), binary);
    fs.writeFileSync(path.join(dir, SAVED_PLAN_SHA), `${sha(binary)}  ${SAVED_PLAN}\n${sha(Buffer.from(planText))}  plan.json\n`);
    return dir;
  }
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await migrationGuardCommand(argv, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  const facts = ["--environment", "staging", "--app-account", FIXTURE.appAccountId, "--region", FIXTURE.region, "--ledger-table-arn", FIXTURE.ledgerTableArn];
  test("7a PASSES only with exactly its two targets recorded", async () => {
    const want = GATE_TARGETS["app-read-authorize"]!;
    assert.deepEqual([...want], ["module.app.aws_iam_role_policy.bootstrap", "module.app.aws_iam_role_policy.operator[0]"]);
    const ok = await run(["app-read-authorize", "--plan-evidence", evidence("app-read-authorize", [...want].reverse()), ...facts]);
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /PASS  evidence: the plan is targeted at exactly the step's resources/);
    for (const [targets, why] of [
      [undefined, /records no -target list/],
      [[], /targets nothing \(an UNTARGETED plan\)/],
      [[want[0]], /exactly module\.app\.aws_iam_role_policy\.bootstrap, module\.app\.aws_iam_role_policy\.operator\[0\] required/],
      [[...want, "module.app.aws_ecs_service.pool[\"p1\"]"], /required/],
      [["module.app"], /required/],
    ] as Array<[unknown, RegExp]>) {
      const r = await run(["app-read-authorize", "--plan-evidence", evidence("app-read-authorize", targets), ...facts]);
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, why);
      assert.match(r.text, /DO NOT APPLY/);
    }
  });
  test("the facts are required (exit 2) and validated", async () => {
    const dir = evidence("app-read-authorize", GATE_TARGETS["app-read-authorize"]);
    const base = ["--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId];
    assert.equal((await run(["app-read-authorize", ...base])).code, 2);
    assert.equal((await run(["app-read-authorize", ...base, "--ledger-table-arn", FIXTURE.ledgerTableArn])).code, 2);
    assert.equal((await run(["app-read-authorize", ...base, "--region", "nowhere", "--ledger-table-arn", FIXTURE.ledgerTableArn])).code, 2);
    const ldir = evidence("ledger-operator-journal", []);
    assert.equal((await run(["ledger-operator-journal", "--plan-evidence", ldir, "--environment", "staging", "--app-account", FIXTURE.appAccountId])).code, 2);
    assert.equal((await run(["ledger-operator-journal", "--plan-evidence", ldir, "--environment", "staging", "--app-account", FIXTURE.appAccountId, "--ledger-table-arn", "table/x"])).code, 2);
    const ok = await run(["ledger-operator-journal", "--plan-evidence", ldir, "--environment", "staging", "--app-account", FIXTURE.appAccountId, "--ledger-table-arn", FIXTURE.ledgerTableArn]);
    assert.equal(ok.code, 0, ok.text);
  });
});

/* ------------------------------------------------------------------ */
/* plan-evidence.{sh,ps1}: the -target record; a CRLF host file is not clean */
/* ------------------------------------------------------------------ */

/** A throwaway git checkout holding plan-evidence and one single-host file (LF or CRLF), committed: git calls it clean
 *  either way (it normalises before comparing) -- exactly an older Windows clone's state the scripts must catch. */
function miniRepo(cr: boolean): { readonly repo: string; readonly bin: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "recon1-repo-"));
  for (const f of ["plan-evidence.sh", "plan-evidence.ps1"]) {
    fs.mkdirSync(path.join(repo, "infra/aws/scripts"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "infra/aws/scripts", f), path.join(repo, "infra/aws/scripts", f));
  }
  fs.mkdirSync(path.join(repo, "infra/aws/stacks/app"), { recursive: true });
  fs.writeFileSync(path.join(repo, "infra/aws/stacks/app/.terraform.lock.hcl"), "# lock\n");
  fs.mkdirSync(path.join(repo, "infra/aws/modules/single-host/files/bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "infra/aws/modules/single-host/files/bin/gs-x"), cr ? "#!/usr/bin/env bash\r\nexit 0\r\n" : "#!/usr/bin/env bash\nexit 0\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "mini");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "recon1-bin-"));
  /* A stub `terraform` (node, so it runs from bash, Windows PowerShell and pwsh alike): -out= gets a binary plan,
     `version` answers the pinned versions, `plan` exits 2 (changes), `show` answers a plan JSON. */
  fs.writeFileSync(
    path.join(bin, "terraform-stub.js"),
    `const a = process.argv.slice(2);
for (const x of a) if (x.startsWith("-out=")) require("fs").writeFileSync(x.slice(5), "BINARY-PLAN");
if (a.includes("version")) { console.log('{"terraform_version":"1.9.8","provider_selections":{"registry.terraform.io/hashicorp/aws":"6.66.0"}}'); process.exit(0); }
if (a.includes("plan")) process.exit(2);
if (a.includes("show")) { console.log('{"format_version":"1.2"}'); process.exit(0); }
`,
  );
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "terraform.cmd"), `@"${process.execPath}" "%~dp0terraform-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  else fs.writeFileSync(path.join(bin, "terraform"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "terraform-stub.js")}" "$@"\n`, { mode: 0o755 });
  return { repo, bin };
}
const TARGETS_7A = ["module.app.aws_iam_role_policy.bootstrap", "module.app.aws_iam_role_policy.operator[0]"];
const POSIX_BASH = process.platform !== "win32" && spawnSync("bash", ["-c", "command -v sha256sum || command -v shasum"]).status === 0 && spawnSync("git", ["--version"]).status === 0;
/* Windows PowerShell 5.1 or PowerShell 7: on Windows this test MUST run (the owner gate fails a skip of it there). */
const PWSH = (process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]).find((c) => spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0) ?? null;

describe("RECON-1A plan-evidence.sh: targets recorded; CR in a host file is NOT clean", { skip: POSIX_BASH ? false : "POSIX bash / git not available (Windows: the .ps1 test)" }, () => {
  for (const cr of [false, true]) {
    test(`a ${cr ? "CRLF" : "LF"} single-host file -> infra_aws_clean ${!cr}`, () => {
      const { repo, bin } = miniRepo(cr);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
      const r = spawnSync("bash", [path.join(repo, "infra/aws/scripts/plan-evidence.sh"), "app", path.join(repo, "ev"), "recon1-7a-sh", "--keep-plan", "-var-file=x.tfvars", `-target=${TARGETS_7A[0]}`, "-target", TARGETS_7A[1]], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const run = JSON.parse(fs.readFileSync(path.join(repo, "ev/terraform/app/run.json"), "utf8"));
      assert.deepEqual(run.targets, TARGETS_7A);
      assert.equal(run.infra_aws_clean, !cr);
      assert.deepEqual(run.host_inputs_with_cr, cr ? ["infra/aws/modules/single-host/files/bin/gs-x"] : []);
      if (cr) assert.match(r.stderr, /single-host files carry CR/);
    });
  }
});

describe("RECON-1A plan-evidence.ps1 (PowerShell 7 where present): the same record", { skip: PWSH === null ? "pwsh not available (the owner's Windows gate runs it)" : false }, () => {
  for (const cr of [false, true]) {
    test(`a ${cr ? "CRLF" : "LF"} single-host file -> infra_aws_clean ${!cr}; -target in both spellings recorded`, () => {
      const { repo, bin } = miniRepo(cr);
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
      /* exactly the runbook's form: -PlanArgs @(...) */
      const q = (x: string) => `'${x.replace(/'/g, "''")}'`;
      const command = `& ${q(path.join(repo, "infra/aws/scripts/plan-evidence.ps1"))} -Stack app -Out ${q(path.join(repo, "ev"))} -Run recon1-7a-ps -KeepPlan -PlanArgs @("-var-file=x.tfvars", "-target=${TARGETS_7A[0]}", "-target", "${TARGETS_7A[1]}")`;
      const r = spawnSync(PWSH!, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { env, encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const run = JSON.parse(fs.readFileSync(path.join(repo, "ev/terraform/app/run.json"), "utf8").replace(/^\uFEFF/, ""));
      assert.deepEqual(run.targets, TARGETS_7A);
      assert.equal(run.infra_aws_clean, !cr);
      assert.deepEqual(run.host_inputs_with_cr, cr ? ["infra/aws/modules/single-host/files/bin/gs-x"] : []);
    });
  }
});

describe("RECON-1A: the guard names a CR-carrying checkout", () => {
  test("host_inputs_with_cr in run.json FAILS the clean-checkout check with the remedy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon1-cr-"));
    const planText = JSON.stringify(PLANS["ecr-lifecycle"]);
    const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
    fs.writeFileSync(path.join(dir, "plan.json"), planText);
    fs.writeFileSync(path.join(dir, "plan-exitcode.txt"), "2\n");
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ terraform_version: "1.9.8", provider_selections: { "registry.terraform.io/hashicorp/aws": "6.66.0" } }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ stack: "single-host", commit: "ee14050f18ba4a51b5af73a5ea9a9a6e89674073", infra_aws_clean: false, targets: [], host_inputs_with_cr: ["infra/aws/modules/single-host/files/bin/gs-deploy"] }));
    fs.writeFileSync(path.join(dir, SAVED_PLAN), "bin");
    fs.writeFileSync(path.join(dir, SAVED_PLAN_SHA), `${sha("bin")}  ${SAVED_PLAN}\n${sha(planText)}  plan.json\n`);
    const lines: string[] = [];
    const code = await migrationGuardCommand(["ecr-lifecycle", "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId], (l) => lines.push(l));
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /FAIL  evidence: planned from a clean, committed checkout: the single host's embedded files carry CR on disk \(infra\/aws\/modules\/single-host\/files\/bin\/gs-deploy\).*re-clone/);
  });
});

/* ------------------------------------------------------------------ */
/* RECON-1: COST-2C's live prerequisites -- the credential authority; the stale-host proof */
/* ------------------------------------------------------------------ */

describe("RECON-1: host-cert's credential authority -- two existing principals, no new IAM", () => {
  const iam = source("infra/aws/modules/app/iam.tf");
  const doc = (name: string): string => {
    const head = new RegExp(`data\\s+"aws_iam_policy_document"\\s+"${name}"\\s*\\{`).exec(iam);
    assert.ok(head, name);
    return blockBody(iam, head.index + head[0].length - 1);
  };
  const statementOf = (body: string, sid: string): string => {
    const hit = childBlocks(body, /statement/).find((st) => new RegExp(`sid\\s*=\\s*"${sid}"`).test(st));
    assert.ok(hit, sid);
    return hit;
  };
  test("the operator role holds the control plane's reads and the lock's one PutItem -- and NO SSM / EC2 / ECS / KMS / IAM authority", () => {
    const op = doc("operator");
    assert.match(statementOf(op, "GameTableRead"), /"dynamodb:GetItem", "dynamodb:Query"/);
    assert.match(statementOf(op, "RoutingAndEvidence"), /"OPRUN#\*"/);
    assert.match(statementOf(op, "IdentityWriterRoleRead"), /"ROLE#identity-writer"/);
    assert.match(statementOf(op, "LedgerRead"), /"dynamodb:GetItem"/);
    assert.match(statementOf(op, "ReadConfiguration"), /"ssm:GetParameter"/);
    const actions = [...op.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    assert.ok(actions.length >= 10, `${actions.length} operator actions parsed`);
    for (const a of actions) assert.match(a, /^(dynamodb:(GetItem|Query|Scan|ConditionCheckItem|PutItem|UpdateItem)|ssm:GetParameter|cloudwatch:PutMetricData)$/, `operator action ${a}`);
    assert.doesNotMatch(op, /ssm:SendCommand|ssm:GetCommandInvocation|ssm:StartSession|ec2:|ecs:|kms:|iam:|sts:/);
    /* and no other role of the module was given the host transport's SSM authority */
    const allActions = [...iam.matchAll(/actions\s*=\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    assert.ok(!allActions.some((a) => /^ssm:(SendCommand|StartSession|GetCommandInvocation)$/i.test(a)), "no module role holds SSM Run Command");
  });
  test("the runbook names both halves, the profile flag, and why no role is added", () => {
    const book = source("infra/aws/SINGLE_HOST_MIGRATION.md");
    assert.match(book, /\*\*The credential authority \(RECON-1\): two existing principals, no new IAM\.\*\*/);
    assert.match(book, /--host-transport-profile <the host-deploy principal's AWS CLI profile>/);
    assert.match(book, /SSM Run Command on the host IS root on the host/);
    assert.match(book, /`gs-staging-operator`\*\* \(the default chain\), UNCHANGED/);
  });
});

describe("RECON-1: the stale-host live sub-proof is classified NOT EVALUATED -- never weakened, never called proven", () => {
  const book = source("infra/aws/SINGLE_HOST_MIGRATION.md");
  test("the runbook classifies it, says why, and lists what stays certified", () => {
    assert.match(book, /\*\*The stale-host live sub-proof: CLASSIFIED NOT EVALUATED \(RECON-1\)\.\*\*/);
    assert.match(book, /an ordinary replacement leaves no old instance, so it proves nothing about a stale one, and it is never\s+called proof of it/);
    assert.match(book, /no such exercise is run/);
    for (const kept of [/host-scripts\.test\.sh/, /host-cert duplicate-fence/, /verify --topology single-host/, /migration-guard host-create/]) assert.match(book.slice(book.indexOf("CLASSIFIED NOT EVALUATED")), kept);
    assert.match(book, /\| \*\*NOT EVALUATED \(classified\)\*\* \| The stale-host live sub-proof/);
  });
  test("the scenario still reports it NOT EVALUATED without a reachable stale host (COST-2C's check unchanged)", () => {
    const sc = source("server/src/aws/deploy/hostcert/scenarios.ts");
    assert.match(sc, /if \(stale === null\) d\.add\(unknown\("replacement: the stale host's preflight refuses \(not the serving EIP\)"/);
    assert.match(sc, /the old host \$\{b\.instance\} is RUNNING and was not declared --stale-instance-id/);
  });
});

describe("RECON-1: the ONE owner gate (COST-2C's runner, extended) covers the reconciled tree", () => {
  const gate = source("infra/aws/single-host/run-cost2c-owner-gate.ps1");
  test("every required suite is in it, cheap gates first, the full server suite LAST, one log + JSON, fail on any non-PASS", () => {
    for (const f of [
      "aws/deploy/migration/recon1AuthorizationGates.test.js",
      "aws/deploy/migration/cost2bMigrationGuards.test.js",
      "aws/deploy/hostcert/hostCert.test.js",
      "aws/deploy/cost2aHostVerifier.test.js",
      "aws/operator/cost2aHostSnapshot.test.js",
      "aws/operator/jx4cOperatorEvidenceIam.test.js",
      "aws/runtime/p5IntCrossSlice.test.js",
      "aws/deploy/staging/rotationProof.test.js",
      "aws/deploy/cost1SingleHost.test.js",
      "aws/awsClients.test.js",
      "infra/aws/modules/single-host/tests/host-scripts.test.sh",
      "tests/preflight-real-docker.test.sh",
    ])
      assert.ok(gate.includes(f), f);
    for (const m of ["modules/single-host", "modules/app", "modules/ledger", "stacks/single-host", "stacks/app", "stacks/ledger"]) assert.ok(gate.includes(`'${m}'`), m);
    assert.match(gate, /'run', 'test:dynamodb-local'/);
    assert.match(gate, /'ls-files', '--eol'/);
    const order = [...gate.matchAll(/^Add-Gate '([^']+)'/gm)].map((m) => m[1]);
    assert.equal(order[0], "Windows LF checkout");
    assert.equal(order[1], "Dependencies (npm ci)");
    assert.equal(order[2], "Build");
    /* the owner-gate correction: a clean clone installs its locked dependencies; the host scripts run in AL2023; the
       COST-2C suite also runs in Linux; the image smokes are built locally and never pushed */
    assert.match(gate, /'ci', '--ignore-scripts', '--no-audit', '--no-fund'/);
    assert.match(gate, /npm ci changed tracked \/ unignored files/);
    assert.match(gate, /\$Al2023Image = 'public\.ecr\.aws\/amazonlinux\/amazonlinux:2023@sha256:[0-9a-f]{64}'/);
    assert.ok(!/Invoke-Logged \$Bash @\('infra\/aws\/modules\/single-host\/tests\/host-scripts\.test\.sh'\)/.test(gate), "the host scripts never run under Git Bash");
    assert.match(gate, /exec bash \/work\/single-host\/tests\/host-scripts\.test\.sh/);
    /* PHASE 1 FRESH-HOST HARDENING: the one-server check also runs against the REAL daemon with AL2023's own CLI */
    const realDocker = gate.slice(gate.indexOf("Add-Gate 'Single-host real Docker'"), gate.indexOf("Add-Gate $ImageGateName"));
    assert.ok(realDocker.length > 0 && gate.indexOf("Add-Gate 'Single-host scripts'") < gate.indexOf("Add-Gate 'Single-host real Docker'"), "the real-Docker gate follows the stubbed one");
    assert.match(realDocker, /dnf -y -q install docker util-linux-core findutils/, "AL2023's OWN docker CLI");
    assert.match(realDocker, /'-v', '\/var\/run\/docker\.sock:\/var\/run\/docker\.sock'/, "the REAL daemon");
    assert.match(realDocker, /preflight-real-docker\.test\.sh ' \+ \$Al2023Image/);
    assert.match(realDocker, /\$counts\[0\] -lt 25/);
    assert.match(gate, /'buildx', 'build', '--platform', \$platform, '-f', 'infra\/docker\/game-server\.Dockerfile'/);
    assert.match(gate, /'--load'/);
    assert.ok(!/--push|ecr get-login|docker login|build-image\.(ps1|sh)'/.test(gate.replace(/^\s*#.*$/gm, "").replace(/'[^']*never --push[^']*'/g, "")), "the smoke never pushes or logs in to ECR");
    assert.match(gate, /tests\/image-smoke\.sh/);
    for (const p of ["linux/amd64", "linux/arm64"]) assert.ok(gate.includes(`'${p}'`), p);
    const dockerfile = source("infra/docker/game-server.Dockerfile");
    const nodeDigest = /ARG NODE_IMAGE=node:22-bookworm-slim@(sha256:[0-9a-f]{64})/.exec(dockerfile)?.[1];
    assert.ok(nodeDigest !== undefined && gate.includes(`node:22-bookworm-slim@${nodeDigest}`), "the Linux COST-2C run uses the server image's own pinned base");
    assert.equal(order[order.length - 1], "Full server suite");
    assert.equal(order[order.length - 2], "DynamoDB Local");
    /* OWNER-GATE FIX 1: every gate must PASS, with ONE exception -- the arm64 runtime smoke may be DEFERRED, and only
       beside a PASSING image gate (arm64 build + architecture proof, amd64 runtime smoke) */
    assert.match(gate, /\$AllPass = \(@\(\$Gates \| Where-Object \{ \$_\.Status -ne 'PASS' -and -not \(\$_\.Status -eq 'DEFERRED' -and \$Deferrable -contains \$_\.Name -and \$ImageGatePassed\) \}\)\.Count -eq 0\)/);
    assert.match(gate, /\$Deferrable = @\(\$Arm64RuntimeGateName\)/);
    assert.match(gate, /if \(\$AllPass\) \{ exit 0 \} else \{ exit 1 \}/);
    for (const k of ["branch =", "head =", "tree_clean =", "started_utc =", "seconds =", "exit =", "owner_source_gate =", "live_host_certification = 'PENDING'", "deferred_to_live ="]) assert.ok(gate.includes(k), k);
    assert.match(gate, /18COSMOS\/RECON-1-OWNER-GATE\/v1/);
  });
  test("OWNER-GATE FIX 1: arm64 is BUILT and architecture-proven locally (no execution); its runtime smoke is PASS only when executed, else DEFERRED -- never PASS -- and fail-closed", () => {
    const code = gate.replace(/^\s*#.*$/gm, "");
    const image = code.slice(code.indexOf("Add-Gate $ImageGateName"), code.indexOf("Add-Gate $Arm64RuntimeGateName"));
    const runtime = code.slice(code.indexOf("Add-Gate $Arm64RuntimeGateName"), code.indexOf("Add-Gate 'DynamoDB Local'"));
    assert.ok(image.length > 0 && runtime.length > 0, "both gates exist, image first");
    /* the build happens BEFORE (and regardless of) the can-it-run probe; a build or architecture failure FAILS the gate */
    assert.ok(image.indexOf("'buildx', 'build'") < image.indexOf("'-p', 'process.arch'"), "build before the runnable probe");
    assert.match(image, /\$problems \+= "\$platform BUILD FAILED/);
    assert.match(image, /\$problems \+= "\$platform ARCHITECTURE PROOF FAILED \(image metadata/);
    assert.match(image, /\$wantMachine = if \(\$arch -eq 'amd64'\) \{ 62 \} else \{ 183 \}/);
    assert.match(image, /Image-ElfMachine \$tag \$platform '\/usr\/local\/bin\/node'/);
    assert.match(code, /function Image-ElfMachine[\s\S]*?'create', '--platform'[\s\S]*?'cp', "\$\{cid\}:\$PathInImage"/);
    assert.doesNotMatch(code.slice(code.indexOf("function Image-ElfMachine"), code.indexOf("function Live-Arm64-Gate-Present")), /'run'|'start'/, "the architecture proof never executes the image");
    /* amd64's runtime smoke is REQUIRED: not runnable or not passing FAILS the image gate */
    assert.match(image, /linux\/amd64 cannot run here \(probe exit \$c`: \$probeLast\): the REQUIRED amd64 runtime smoke was NOT RUN/);
    /* "no emulation" is concluded ONLY from an exec format error; any other probe failure is NOT RUN (fails the source gate) */
    assert.match(image, /elseif \(\$probeText -match 'exec format error'\) \{ \$script:Arm64Runtime = 'DEFERRED'/);
    assert.match(image, /else \{ \$script:Arm64Runtime = 'NOT RUN'; \$script:Arm64RuntimeDetail = "the linux\/arm64 runnable probe failed for another reason/);
    assert.match(image, /if \(\$arch -eq 'amd64'\) \{ if \(-not \$verdict\.StartsWith\('PASS'\)\) \{ \$problems \+= /);
    /* the runtime gate: BLOCKED unless the image gate PASSED; PASS only from an executed smoke; DEFERRED only with the live gate present */
    assert.match(runtime, /\$image\.Status -ne 'PASS'\) \{ return @\{ Status = 'BLOCKED'/);
    assert.match(runtime, /'PASS' \{ return @\{ Exit = 0/);
    assert.match(runtime, /if \(-not \(Live-Arm64-Gate-Present\)\) \{ return @\{ Status = 'FAIL'/);
    assert.match(runtime, /return @\{ Status = 'DEFERRED'; Exit = \$null; Reason = 'ARM64 runtime smoke: DEFERRED TO REQUIRED LIVE GRAVITON GATE/);
    assert.equal((code.match(/Status = 'DEFERRED'/g) ?? []).length, 1, "nothing else may be DEFERRED");
    assert.match(image, /\$script:Arm64Runtime = if \(\$verdict\.StartsWith\('PASS'\)\) \{ 'PASS' \}/);
    /* the summary distinguishes the source gate from the pending live certification */
    assert.match(code, /OWNER SOURCE GATE: \{0\}/);
    assert.match(code, /LIVE HOST CERTIFICATION: PENDING/);
    assert.match(code, /function Live-Arm64-Gate-Present[\s\S]*?\^12b\\\. [\s\S]*?gs-host\\\.ps1 -Command arm64-smoke[\s\S]*?--arm64-live-smoke[\s\S]*?the edge cutover needs --arm64-live-smoke/);
  });
  test("OWNER-GATE FIX 1: the runbook's live ARM64 gate is mandatory, BEFORE deploy and BEFORE the edge cutover, and the cutover guard needs it", () => {
    const book = source("infra/aws/SINGLE_HOST_MIGRATION.md");
    const at = (re: RegExp): number => {
      const m = re.exec(book);
      assert.ok(m, String(re));
      return m.index;
    };
    const s12 = at(/^12\. Build the release image/m);
    const s12b = at(/^12b\. \*\*REQUIRED -- the live ARM64 runtime smoke on the real Graviton host/m);
    const s13 = at(/^13\. Deploy/m);
    const s14 = at(/^14\. `APP-ADMIN`/m);
    assert.ok(s12 < s12b && s12b < s13 && s13 < s14, "12 < 12b < 13 < 14");
    const step12b = book.slice(s12b, s13);
    assert.match(step12b, /gs-host\.ps1 -Command arm64-smoke -InstanceId <id> -Digest/);
    assert.match(step12b, /\*\*FAIL is a STOP\*\*/);
    assert.match(step12b, /\*\*NOT EVALUATED\*\*[\s\S]*\*\*blocks the cutover\*\*/);
    assert.match(step12b, /never inferred from the amd64 smoke/);
    assert.match(book.slice(s14), /migration-guard edge-cutover --plan-evidence [^\n]*--arm64-live-smoke <D>\\arm64-live-smoke\.txt --release-digest/);
    assert.match(book, /\| \*\*REQUIRED LIVE \(pre-cutover\)\*\* \| \*\*The ARM64 runtime smoke\*\*/);
    assert.match(book, /DEFERRED TO REQUIRED LIVE\s+GRAVITON GATE/);
    assert.match(book, /--direction rollback/);
    assert.doesNotMatch(book, /buildx, arm64 emulation\)/, "arm64 emulation is no longer an owner prerequisite");
    const guard = source("server/src/aws/deploy/migration/migrationCommands.ts");
    assert.match(guard, /if \(direction === "cutover" && \(flags\.get\("--arm64-live-smoke"\) === undefined \|\| flags\.get\("--release-digest"\) === undefined \|\| flags\.get\("--instance-id"\) === undefined\)\)/);
    assert.match(guard, /judgeArm64LiveSmoke\(decodeCapture\(raw\)/);
    /* a rollback is proven from the forward PASS record and the plan, never taken on the operator's word */
    assert.match(guard, /if \(direction === "rollback" && flags\.get\("--cutover-record"\) === undefined\)/);
    assert.match(guard, /smokeChecks\.push\(\.\.\.rollbackChecks\(/);
    assert.match(book, /--direction rollback --cutover-record <D>\\guards\\14\.json/);
  });
});

/* ------------------------------------------------------------------ */
/* The runbook and the README                                           */
/* ------------------------------------------------------------------ */

describe("RECON-1A: the runbook -- no ordinary app-stack apply before compute-none; 7a / 7b before step 8", () => {
  const RUNBOOK = source("infra/aws/SINGLE_HOST_MIGRATION.md");
  const README = source("infra/aws/README.md");
  test("COST-2A's D0 (an ordinary app apply for the verifier grants) is gone, from the runbook and the README", () => {
    assert.doesNotMatch(RUNBOOK, /^\s*D0\./m);
    assert.doesNotMatch(RUNBOOK, /`stacks\/app` at this commit with \*\*unchanged inputs\*\*/);
    assert.doesNotMatch(RUNBOOK, /plan shows \*\*only\*\* the bootstrap\s+role's policy/);
    assert.doesNotMatch(README, /step D0\)/);
    assert.doesNotMatch(README, /Apply it\s+before the host verification is first needed/);
    assert.match(RUNBOOK, /there is no ordinary app-stack apply before compute-none, for any reason/);
    assert.match(README, /\*\*Never by an ordinary app-stack apply\*\*/);
  });
  test("7a (targeted, exactly the two policies) and 7b run after §A and before step 8", () => {
    const at = (re: RegExp): number => {
      const m = re.exec(RUNBOOK);
      assert.ok(m, String(re));
      return m.index;
    };
    const a1 = at(/^1\. `BOOT`\/`OPER`: prove S1-S8/m);
    const s7a = at(/^7a\. `APP-ADMIN`/m);
    const s7b = at(/^7b\. `LEDGER-ADMIN`/m);
    const s8 = at(/^8\. `LEDGER-ADMIN`/m);
    const s9 = at(/^9\. `APP-ADMIN`/m);
    assert.ok(a1 < s7a && s7a < s7b && s7b < s8 && s8 < s9, "§A < 7a < 7b < 8 < 9");
    const step7a = RUNBOOK.slice(s7a, s7b);
    assert.match(step7a, /-target=module\.app\.aws_iam_role_policy\.bootstrap", "-target=module\.app\.aws_iam_role_policy\.operator\[0\]"/);
    assert.match(step7a, /migration-guard app-read-authorize --plan-evidence/);
    assert.match(RUNBOOK.slice(s7b, s8), /migration-guard ledger-operator-journal/);
    for (const gate of ["app-read-authorize", "ledger-operator-journal"]) assert.match(RUNBOOK, new RegExp(`\\| 7[ab] \\| [^|]+ \\| \`migration-guard ${gate}\\b`));
  });
  test("§0's accepted state, the saved-plan model and the NAT gate are kept; GO-C / g2 adoption never returns", () => {
    for (const fact of [/APPGEN\s*(=|is)\s*1/, /g1.*authoritative/i, /g2.*UNADOPTED/, /0\/0\/0/, /recovery role and its policy are removed/i, /Break-glass is OFF/, /0 money games/, /RELAYQ#<relayer>` is empty/, /GO-C \(`appgen-adopt`\) was NOT run/, /migration-guard nat\b/, /-KeepPlan/]) assert.match(RUNBOOK, fact);
    for (const l of RUNBOOK.split("\n").filter((x) => /GO-C|appgen-adopt|adopt.*g2|g2.*adopt/i.test(x))) assert.match(l, /\b(never|not|no|NOT|NEVER|without|UNADOPTED|unadopted)\b/, l);
    /* COST-2A's verifier workflow is in: coexist (F0), post-cutover (15b), the final inventory (J24) */
    assert.match(RUNBOOK, /verify --topology coexist/);
    assert.match(RUNBOOK, /^15b\. \(COST-2A\)/m);
    assert.match(RUNBOOK, /verify --topology single-host/);
    assert.match(RUNBOOK, /capture-host-evidence/);
    assert.match(RUNBOOK, /host-snapshot/);
  });
  test("every gate is in the runbook and the awsDeploy USAGE", () => {
    const commands = source("server/src/aws/deploy/commands.ts");
    for (const gate of GATE_NAMES) {
      assert.match(RUNBOOK, new RegExp(`migration-guard ${gate}\\b`), gate);
      assert.match(commands, new RegExp(`migration-guard \\([^)]*\\b${gate}\\b`), gate);
    }
    assert.deepEqual(GATE_NAMES.slice(0, 2), ["app-read-authorize", "ledger-operator-journal"]);
    void TASK_ROLE;
  });
});
