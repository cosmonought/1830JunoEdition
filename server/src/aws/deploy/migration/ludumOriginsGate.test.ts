// server/src/aws/deploy/migration/ludumOriginsGate.test.ts
//
// LUDUM (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §13): the `ludum-origins` migration guard -- the ONLY reviewed way the
// Ludum origin reaches the staging runtime document. Over SYNTHETIC saved plans (planFixtures.ts). The focus is FALSE
// ACCEPTANCE: the valid delivery and its rollback pass; every way a plan could do more, do it to the wrong stack state,
// or name another origin, fails by name. Also pinned: the CLI's operator fact, and that nothing in the single-host module
// (its user_data / server.env) can carry a Ludum origin -- a document change never replaces the host.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { judgeMigrationPlan, ludumDocumentProblem, ludumOriginsProblem, type MigrationContext } from "./planGuards";
import { migrationGuardCommand } from "./migrationCommands";
import { FIXTURE, jsonencode, runtimeDocument, validPlans } from "./planFixtures";
import { readCheckoutText } from "../../../testSupport/portability";
import { parseAwsRuntimeConfig } from "../../runtime/runtimeConfig";

const REPO = path.resolve(__dirname, "../../../../../../..");
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const A = "module.app";
const DOC = `${A}.aws_ssm_parameter.runtime["p1"]`;
const L = FIXTURE.ludumOrigin;

const CTX: MigrationContext = { environment: FIXTURE.environment, appAccountId: FIXTURE.appAccountId, servingGeneration: 1, pool: "p1", retiredPools: ["p2"], ludumOrigins: [L] };
const plan = (): Obj => clone(validPlans()["ludum-origins"]) as Obj;
const rc = (p: Obj, address: string): Obj => {
  const hit = (p.resource_changes as Obj[]).find((r) => r.address === address);
  assert.ok(hit, `fixture has ${address}`);
  return hit as Obj;
};
const judge = (p: unknown, ctx: MigrationContext = CTX) => judgeMigrationPlan("ludum-origins", p, ctx);
const failures = (p: unknown, ctx: MigrationContext = CTX) => judge(p, ctx).checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`).join("\n");
function rejects(p: unknown, why: RegExp, ctx: MigrationContext = CTX): void {
  const r = judge(p, ctx);
  assert.equal(r.verdict, "FAIL", `expected FAIL (${why})`);
  assert.match(failures(p, ctx), why);
}

describe("LUDUM ludum-origins gate: the valid delivery and its rollback", () => {
  test("the valid plan PASSES: exactly p1's document gains exactly the named origin", () => {
    const r = judge(plan());
    assert.equal(r.verdict, "PASS", failures(plan()));
    assert.deepEqual(r.summary.changes, [`${DOC} [update]`]);
    const after = JSON.parse(String(rc(plan(), DOC).change.after.insecure_value));
    assert.deepEqual(after.ludum_origins, [L]);
  });
  test("the rollback (--ludum-origins none) PASSES: the field leaves, everything else equal", () => {
    const p = plan();
    const d = rc(p, DOC);
    [d.change.before.insecure_value, d.change.after.insecure_value] = [d.change.after.insecure_value, d.change.before.insecure_value];
    p.variables.ludum_origins = { value: [] };
    const r = judge(p, { ...CTX, ludumOrigins: [] });
    assert.equal(r.verdict, "PASS", failures(p, { ...CTX, ludumOrigins: [] }));
  });
});

describe("LUDUM ludum-origins gate: false acceptance", () => {
  test("the origin is the operator's, never the plan's", () => {
    rejects(plan(), /--ludum-origins .* is required/, { ...CTX, ludumOrigins: undefined });
    rejects(plan(), /must become exactly \["https:\/\/other\.example\.org"\]/, { ...CTX, ludumOrigins: ["https://other.example.org"] });
    rejects(plan(), /must be ABSENT/, { ...CTX, ludumOrigins: [] });
    const v = plan();
    v.variables.ludum_origins = { value: ["https://other.example.org"] };
    rejects(v, /ludum_origins = \["https:\/\/other\.example\.org"\]/);
  });
  test("only appropriate https origins are ever named", () => {
    for (const bad of ["http://ludum.example.org", "https://*.example.org", "https://ludum.example.org/", "https://ludum.example.org:8443", "https://LUDUM.example.org", "null", "ludum.example.org"]) {
      assert.notEqual(ludumOriginsProblem([bad]), null, bad);
      rejects(plan(), /the Ludum origins are named/, { ...CTX, ludumOrigins: [bad] });
    }
    assert.match(String(ludumOriginsProblem([L, L])), /repeated/);
    assert.match(String(ludumOriginsProblem(Array.from({ length: 9 }, (_, i) => `https://l${i}.example.org`))), /at most 8/);
    assert.equal(ludumOriginsProblem([L]), null);
  });
  test("a Ludum origin that is also Play's is refused (it would never need CORS, and must never gain Play's routes)", () => {
    const p = plan();
    p.variables.allowed_origins = { value: [FIXTURE.playOrigin, L] };
    rejects(p, /also a Play \(allowed_origins\) origin/);
  });
  test("the document may change ludum_origins and nothing else", () => {
    const mutate = (edit: (doc: Obj) => void): Obj => {
      const p = plan();
      const d = rc(p, DOC);
      const doc = JSON.parse(String(d.change.after.insecure_value));
      edit(doc);
      d.change.after.insecure_value = jsonencode(doc);
      return p;
    };
    rejects(mutate((d) => (d.routes = { p1: { ws_path: "/gs/p/p1" }, p2: { ws_path: "/gs/p/p2" } })), /changes more than ludum_origins/);
    rejects(mutate((d) => (d.ledger_table_arn = "arn:aws:dynamodb:us-east-1:333333333333:table/evil")), /changes more than ludum_origins/);
    rejects(mutate((d) => (d.escrow = null)), /changes more than ludum_origins/);
    rejects(mutate((d) => (d.ludum_origins = [L, "https://extra.example.org"])), /must become exactly/);
    rejects(mutate((d) => (d.format = "18COSMOS/AWS-RUNTIME/v1")), /v2 runtime document/);
    const dup = plan();
    rc(dup, DOC).change.after.insecure_value = String(rc(dup, DOC).change.after.insecure_value).replace("{", `{"ludum_origins":["https://evil.example.org"],`);
    rejects(dup, /duplicate key|unreadable/);
    const unknown = plan();
    rc(unknown, DOC).change.after.insecure_value = null;
    rc(unknown, DOC).change.after_unknown = { insecure_value: true, version: true };
    rejects(unknown, /unknown/);
  });
  test("the document is updated in place: never replaced, destroyed, re-typed or renamed", () => {
    const rep = plan();
    rc(rep, DOC).change.actions = ["delete", "create"];
    rejects(rep, /DESTROYED \/ REPLACED/);
    const typ = plan();
    rc(typ, DOC).change.after.type = "SecureString";
    rejects(typ, /also changes type/);
    const tier = plan();
    rc(tier, DOC).change.after.tier = "Advanced";
    rejects(tier, /also changes tier/);
    const same = plan();
    rc(same, DOC).change.after.insecure_value = rc(same, DOC).change.before.insecure_value;
    rc(same, DOC).change.actions = ["no-op"];
    rejects(same, /does not contain|is no-op/);
  });
  test("ANY other mutation refuses the plan: Juno document, IAM, tables, edge, ECR", () => {
    const juno = plan();
    const j = rc(juno, `${A}.aws_ssm_parameter.juno_backend[0]`);
    j.change.actions = ["update"];
    j.change.after = { ...j.change.after, insecure_value: jsonencode({ format: "18COSMOS/JUNO-BACKEND/v3", chain_id: "juno-1" }) };
    rejects(juno, /juno_backend\[0\].*NOT PART OF THIS STEP/);
    const iam = plan();
    const b = rc(iam, `${A}.aws_iam_role_policy.bootstrap`);
    b.change.actions = ["update"];
    b.change.after = { ...b.change.after, policy: String(b.change.after.policy).replace("dynamodb:GetItem", "dynamodb:*") };
    rejects(iam, /NOT PART OF THIS STEP/);
    const edge = plan();
    const dist = rc(edge, `${A}.aws_cloudfront_distribution.site[0]`);
    dist.change.actions = ["update"];
    dist.change.after = { ...dist.change.after, aliases: ["play.example.org", "ludum.example.org"] };
    rejects(edge, /NOT PART OF THIS STEP/);
    const table = plan();
    const t = rc(table, `${A}.aws_dynamodb_table.identity`);
    t.change.actions = ["update"];
    t.change.after = { ...t.change.after, deletion_protection_enabled: false };
    rejects(table, /no table, key, IAM, edge, ECR or other document change/);
  });
  test("the FROZEN stack (the desired-count drift) can never take this delivery", () => {
    const frozen = clone(validPlans()["compute-none"]) as Obj;
    rejects(frozen, /no ECS-era object in the prior state|ECS untouched|NOT PART OF THIS STEP/);
    const prior = plan();
    const ecs = { address: `${A}.aws_ecs_service.pool["p1"]`, mode: "managed", type: "aws_ecs_service", name: "pool", index: "p1", provider_name: "registry.terraform.io/hashicorp/aws", schema_version: 0, values: { desired_count: 1 } };
    prior.prior_state.values.root_module.child_modules[0].resources.push(ecs);
    rejects(prior, /still FROZEN/);
    const restart = plan();
    (restart.resource_changes as Obj[]).push({ ...clone(rc(restart, DOC)), address: `${A}.aws_ecs_service.pool["p1"]`, type: "aws_ecs_service", name: "pool", index: "p1", change: { actions: ["update"], before: { desired_count: 0 }, after: { desired_count: 1 }, after_unknown: {}, before_sensitive: {}, after_sensitive: {} } });
    rejects(restart, /RESTART|ECS untouched/);
    const ecsVar = plan();
    ecsVar.variables.compute = { value: "ecs" };
    rejects(ecsVar, /compute = "ecs"/);
    const glass = plan();
    glass.variables.recovery_break_glass = { value: true };
    rejects(glass, /recovery_break_glass = true/);
  });
  test("ludumDocumentProblem directly: before == after is nothing to apply", () => {
    const doc = runtimeDocument(["p1"], "p1", [L]);
    assert.match(String(ludumDocumentProblem(doc, doc, CTX)), /does not change/);
    assert.equal(ludumDocumentProblem(runtimeDocument(["p1"]), doc, CTX), null);
  });
});

describe("LUDUM ludum-origins: the command's operator fact", () => {
  const run = async (args: string[]) => {
    const lines: string[] = [];
    const code = await migrationGuardCommand(args, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  const base = ["--plan-evidence", "/nonexistent", "--environment", FIXTURE.environment, "--app-account", FIXTURE.appAccountId];
  test("ludum-origins needs --ludum-origins; no other gate takes it; entries are exact", async () => {
    let r = await run(["ludum-origins", ...base]);
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /ludum-origins needs --ludum-origins/);
    r = await run(["ecr-lifecycle", ...base, "--ludum-origins", L]);
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /--ludum-origins belongs to ludum-origins/);
    for (const bad of [`${L},`, ` ${L}`, `${L},,https://x.example.org`]) {
      r = await run(["ludum-origins", ...base, "--ludum-origins", bad]);
      assert.equal(r.code, 2, bad);
      assert.match(r.text, /no empty or padded entry/);
    }
    r = await run(["ludum-origins", ...base, "--ludum-origins", "none"]);
    assert.notEqual(r.code, 2, "none is accepted as the rollback's empty list (the missing evidence then FAILS)");
  });
});

describe("LUDUM: the origin travels ONLY in the runtime document", () => {
  const read = (rel: string): string => readCheckoutText(path.join(REPO, rel));
  const walk = (dir: string): string[] => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.name === ".terraform" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  test("nothing in the single-host module (user_data, server.env, host IAM) names a Ludum origin", () => {
    for (const file of walk("infra/aws/modules/single-host").filter((f) => /\.(tf|tftpl|sh|service|json|hcl)$/.test(f))) assert.doesNotMatch(read(file), /ludum/i, file);
    assert.doesNotMatch(read("infra/aws/modules/single-host/templates/server.env.tftpl"), /LUDUM|ludum/);
  });
  test("the app module writes it into the runtime document only (never a task environment)", () => {
    const locals = read("infra/aws/modules/app/locals.tf");
    assert.equal((locals.match(/length\(var\.ludum_origins\) > 0 \? \{ ludum_origins = var\.ludum_origins \} : \{\}/g) ?? []).length, 1, "the document's one conditional field");
    assert.equal((locals.match(/^(?!\s*#).*var\.ludum_origins/gm) ?? []).length, 1, "used nowhere else in locals");
    assert.doesNotMatch(locals, /GS_LUDUM_ORIGINS/);
    for (const f of ["ecs.tf", "iam.tf", "edge.tf", "ssm.tf"]) assert.doesNotMatch(read(`infra/aws/modules/app/${f}`), /ludum/i, f);
  });
});

describe("LUDUM: the delivered document is the one the server parses", () => {
  test("the module's rendering (with and without ludum_origins) is accepted by parseAwsRuntimeConfig", () => {
    const withField = parseAwsRuntimeConfig(JSON.parse(runtimeDocument(["p1"], "p1", [L])));
    assert.deepEqual([...withField.ludumOrigins], [L]);
    const without = parseAwsRuntimeConfig(JSON.parse(runtimeDocument(["p1"])));
    assert.deepEqual([...without.ludumOrigins], [], "no field: no Ludum origin");
    assert.throws(() => parseAwsRuntimeConfig(JSON.parse(runtimeDocument(["p1"], "p1", ["http://ludum.example.org"]))), /ludum_origins/);
  });
});
