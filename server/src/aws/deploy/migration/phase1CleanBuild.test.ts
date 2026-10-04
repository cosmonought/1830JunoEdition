// server/src/aws/deploy/migration/phase1CleanBuild.test.ts
//
// PHASE 1 CLEAN-BUILD RESET (static; no AWS, no Terraform run): the clean final-state architecture and its Phase-1 plan,
// pinned so the expensive topology cannot come back by accident and the plan cannot drift from the guards it reuses.
//   inventory  infra/aws/PHASE1_INVENTORY.json classifies EVERY Terraform declaration of modules/app, modules/ledger
//              and modules/single-host exactly once (a new resource fails here until it is classified); its
//              DELETE-LEGACY app resources are exactly the compute-none guard's teardown classes (+ p2's runtime
//              document) and cover COST_BUDGET.json's gated list; nothing the guard tears down is kept; every budget item
//              is backed by a KEEP entry; its final state is what the compute-none guard requires
//   explicit   stacks/app's `compute` and stacks/ledger's `ecs_task_role_authorized` have NO default (an omitted line
//              can neither recreate the ECS / ALB / endpoint topology nor re-grant the deleted task role's name); the
//              modules' defaults are unchanged; the examples state the final values; nothing else under
//              infra/aws/modules or infra/aws/stacks moved since the Phase-1 base
//   order      the teardown runs edge-cutover BEFORE compute-none because the guards force it (edge-cutover requires
//              compute = "ecs"; compute-none forbids any distribution change), forward only, an owner GO per mutation
//   R5         the direct certification names the final-system tools and none of the retired migration gates; its
//              acceptance rule names the drills' own availability-only checks
//   pointers   SINGLE_HOST_MIGRATION.md is RETIRED as the governing plan; the canonical context, the budget record and
//              the READMEs point at PHASE1_CLEAN_BUILD.md; this suite runs in `npm test` and the owner gate

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { readCheckoutText } from "../../../testSupport/portability";
import { judgeMigrationPlan, TEARDOWN_CLASSES, type MigrationContext } from "./planGuards";
import { FIXTURE, validPlans } from "./planFixtures";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const read = (rel: string): string => readCheckoutText(path.join(REPO, rel));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The Phase-1 base this reset starts from (recon/phase1-fresh-host-hardening's head). */
const RESET_BASE = "50c1cfcda04ccd6d0b6e36e6db2e3629d37312e0";

const INVENTORY = JSON.parse(read("infra/aws/PHASE1_INVENTORY.json")) as Obj;
const BUDGET = JSON.parse(read("infra/aws/COST_BUDGET.json")) as Obj;
const PLAN = read("infra/aws/PHASE1_CLEAN_BUILD.md");
const TEARDOWN = read("infra/aws/PHASE1_LEGACY_TEARDOWN.md");
const BOOK = read("infra/aws/SINGLE_HOST_MIGRATION.md");

const CLASSES = ["KEEP-DURABLE", "KEEP-HOST", "DELETE-LEGACY", "DELETE-MIGRATION", "REVIEW"] as const;
type Entry = { id: string; class: (typeof CLASSES)[number]; ownership: string; resources: Array<[string, string]>; instances?: string[]; teardown_step?: string; budget_items: string[]; [k: string]: unknown };
const ENTRIES = INVENTORY.entries as Entry[];
const MODULE_OF: Readonly<Record<string, string>> = { app: "infra/aws/modules/app", ledger: "infra/aws/modules/ledger", "single-host": "infra/aws/modules/single-host" };
const stackOf = (e: Entry): string | null => /^terraform:([a-z-]+)/.exec(e.ownership)?.[1] ?? null;

/** HCL without comments (# and // line comments, block comments) -- enough for declarations and variable blocks. */
function stripHcl(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== "\\") quoted = !quoted;
        if (!quoted && (c === "#" || (c === "/" && line[i + 1] === "/"))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Every top-level `resource "<type>" "<name>"` of a module's own .tf files (tests and .terraform excluded). Read from the
 *  RAW text at column 0 (where every block of these modules starts; a commented-out one starts with `#`): stripping block
 *  comments naively would also swallow an ARN pattern such as `.../*"` up to the next banner comment. */
function declared(moduleDir: string): Array<[string, string]> {
  const dir = path.join(REPO, moduleDir);
  const out: Array<[string, string]> = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".tf")).sort()) {
    const text = readCheckoutText(path.join(dir, name));
    for (const m of text.matchAll(/^resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"\s*\{/gm)) out.push([m[1], m[2]]);
    /* An indented declaration would escape this scan: there is none, and none may appear unseen. */
    assert.doesNotMatch(text, /^[ \t]+resource\s+"/m, `${moduleDir}/${name}: every resource block starts at column 0`);
  }
  return out;
}

/** The brace-matched body of `variable "<name>" { ... }` in comment-stripped HCL. */
function variableBlock(hcl: string, name: string): string {
  const start = hcl.search(new RegExp(`variable\\s+"${name}"\\s*\\{`));
  assert.ok(start >= 0, `variable "${name}" is declared`);
  let depth = 0;
  for (let i = hcl.indexOf("{", start); i < hcl.length; i += 1) {
    if (hcl[i] === "{") depth += 1;
    if (hcl[i] === "}" && --depth === 0) return hcl.slice(start, i + 1);
  }
  throw new Error(`unbalanced variable ${name}`);
}

const key = (type: string, name: string) => `${type}.${name}`;
const git = (args: string[]) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const baseAvailable = git(["cat-file", "-e", `${RESET_BASE}^{commit}`]).status === 0;

const CTX: MigrationContext = { environment: FIXTURE.environment, appAccountId: FIXTURE.appAccountId, servingGeneration: 1, pool: "p1", retiredPools: ["p2"], originDomain: FIXTURE.hostOrigin, minEcrKeepImages: 20, region: FIXTURE.region, ledgerTableArn: FIXTURE.ledgerTableArn, signingKeyArns: FIXTURE.signingKeyArns };
const PLANS = validPlans();
const failedChecks = (r: ReturnType<typeof judgeMigrationPlan>) => r.checks.filter((c) => c.status !== "pass").map((c) => c.name);

/* ================================================================== */

describe("P1-R1: the retain / delete / review inventory", () => {
  test("its shape: the format, the five classes, the governing documents, one entry per id with every field", () => {
    assert.equal(INVENTORY.format, "18COSMOS/PHASE1-INVENTORY/v1");
    assert.deepEqual(Object.keys(INVENTORY.classes as Obj), [...CLASSES]);
    assert.equal(INVENTORY.governing_procedure, "infra/aws/PHASE1_CLEAN_BUILD.md");
    assert.equal(INVENTORY.teardown_procedure, "infra/aws/PHASE1_LEGACY_TEARDOWN.md");
    for (const doc of [INVENTORY.governing_procedure, INVENTORY.teardown_procedure]) assert.ok(fs.existsSync(path.join(REPO, doc as string)), doc as string);
    const ids = ENTRIES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "ids are unique");
    for (const e of ENTRIES) {
      assert.ok((CLASSES as readonly string[]).includes(e.class), `${e.id}: class ${e.class}`);
      for (const field of ["what", "ownership", "account", "resources", "live_names", "dependencies", "reversible", "principal_effect", "state_action", "budget_items"]) assert.ok(field in e, `${e.id} has ${field}`);
      assert.ok(/^(terraform:(app|ledger|single-host)\b|outside-terraform:)/.test(e.ownership), `${e.id}: ownership ${e.ownership}`);
      if (stackOf(e) === null) assert.deepEqual(e.resources, [], `${e.id}: an outside resource names no Terraform declaration`);
      else assert.ok(e.resources.length > 0, `${e.id}: a Terraform entry names its declarations`);
      /* A deletion has its place in the teardown; a kept resource has none; a REVIEW entry may name the step that judges it. */
      if (e.class === "DELETE-LEGACY" || e.class === "DELETE-MIGRATION") assert.match(String(e.teardown_step), /^T[1-8]$/, `${e.id} names its teardown step`);
      else if (e.class !== "REVIEW") assert.equal(e.teardown_step, undefined, `${e.id} (${e.class}) is never torn down`);
      if (e.class === "DELETE-MIGRATION") assert.ok(Array.isArray(e.preconditions) && (e.preconditions as unknown[]).length > 0, `${e.id}: deleted only after its stated proof`);
      if (e.teardown_step !== undefined) assert.match(TEARDOWN, new RegExp(`^## ${e.teardown_step} `, "m"), `the teardown has ${e.teardown_step}`);
    }
  });

  test("every Terraform declaration of the three modules is classified exactly once (split only by disjoint instance keys)", () => {
    for (const [stack, moduleDir] of Object.entries(MODULE_OF)) {
      const decl = declared(moduleDir);
      assert.ok(decl.length > 0, moduleDir);
      const owners = new Map<string, Entry[]>();
      for (const e of ENTRIES.filter((x) => stackOf(x) === stack)) {
        for (const [type, name] of e.resources) owners.set(key(type, name), [...(owners.get(key(type, name)) ?? []), e]);
      }
      for (const [type, name] of decl) {
        const by = owners.get(key(type, name)) ?? [];
        assert.ok(by.length > 0, `${moduleDir}: ${key(type, name)} is not classified in PHASE1_INVENTORY.json (classify it: KEEP, DELETE or REVIEW)`);
        if (by.length > 1) {
          const keys = by.map((e) => e.instances ?? []);
          assert.ok(keys.every((k) => k.length > 0), `${key(type, name)}: classified twice without instance keys (${by.map((e) => e.id).join(", ")})`);
          const flat = keys.flat();
          assert.equal(new Set(flat).size, flat.length, `${key(type, name)}: overlapping instance keys`);
        }
      }
      const known = new Set(decl.map(([t, n]) => key(t, n)));
      for (const k of owners.keys()) assert.ok(known.has(k), `the inventory names ${k} in ${moduleDir}, which declares no such resource (a stale entry)`);
    }
  });

  test("DELETE-LEGACY in modules/app is exactly the compute-none guard's teardown classes plus p2's runtime document, covering COST_BUDGET's gated list", () => {
    const legacy = ENTRIES.filter((e) => e.class === "DELETE-LEGACY" && stackOf(e) === "app");
    const whole = new Set(legacy.filter((e) => e.instances === undefined).flatMap((e) => e.resources.map(([t, n]) => key(t, n))));
    const guard = new Set(TEARDOWN_CLASSES.flatMap((k) => k.resources.map(([t, n]) => key(t, n))));
    assert.deepEqual([...whole].sort(), [...guard].sort(), "the inventory's ECS-era deletions = what migration-guard compute-none requires destroyed");
    const split = legacy.filter((e) => e.instances !== undefined);
    assert.deepEqual(split.map((e) => [e.resources, e.instances]), [[[["aws_ssm_parameter", "runtime"]], ["p2"]]], "only p2's runtime document is deleted by instance key");
    for (const address of BUDGET.ecs_era_compute_gate.gated_resources as string[]) assert.ok(whole.has(address), `COST_BUDGET.json gates ${address}: the inventory deletes it`);
  });

  test("nothing the guard tears down is kept; the durable authorities are KEEP-DURABLE; the whole single-host module is KEEP-HOST", () => {
    const guard = new Set(TEARDOWN_CLASSES.flatMap((k) => k.resources.map(([t, n]) => key(t, n))));
    for (const e of ENTRIES.filter((x) => x.class.startsWith("KEEP") && stackOf(x) === "app")) {
      for (const [t, n] of e.resources) assert.ok(!guard.has(key(t, n)), `${e.id} keeps ${key(t, n)}, which compute-none destroys`);
    }
    const durable = new Set(ENTRIES.filter((e) => e.class === "KEEP-DURABLE").flatMap((e) => e.resources.map(([t, n]) => `${stackOf(e)}:${key(t, n)}`)));
    for (const authority of [
      "app:aws_dynamodb_table.game",
      "app:aws_dynamodb_table.identity",
      "app:aws_ssm_parameter.juno_backend",
      "app:aws_ecr_repository.server",
      "app:aws_cloudfront_distribution.site",
      "app:aws_cloudfront_origin_request_policy.gs",
      "app:aws_iam_role.bootstrap",
      "app:aws_iam_role.operator",
      "ledger:aws_dynamodb_table.ledger",
      "ledger:aws_dynamodb_resource_policy.ledger",
      "ledger:aws_backup_vault.ledger",
      "ledger:aws_backup_vault_lock_configuration.ledger",
      "ledger:aws_kms_key.signing",
    ]) assert.ok(durable.has(authority), `${authority} is a durable authority (KEEP-DURABLE)`);
    const p1 = ENTRIES.find((e) => e.resources.some(([t, n]) => t === "aws_ssm_parameter" && n === "runtime") && e.instances?.includes("p1"));
    assert.equal(p1?.class, "KEEP-DURABLE", "the p1 runtime document is kept");
    for (const e of ENTRIES.filter((x) => stackOf(x) === "single-host")) assert.equal(e.class, "KEEP-HOST", `${e.id}: every single-host resource is the final hosting plane`);
    for (const e of ENTRIES.filter((x) => x.class === "KEEP-HOST" && stackOf(x) !== null)) assert.equal(stackOf(e), "single-host", `${e.id}: the hosting plane is stacks/single-host`);
    /* The final hosting plane declares no prohibited (fixed-cost) type (COST-1's own scan, restated over the classification). */
    for (const e of ENTRIES.filter((x) => x.class === "KEEP-HOST")) for (const [t] of e.resources) assert.ok(!(BUDGET.prohibited_resource_types as string[]).includes(t), `${e.id}: ${t} is prohibited in the low-cost topology`);
  });

  test("the NAT and the VPC are REVIEW (never deleted without evidence); g2 is deleted only after its proof; nothing outside Terraform is silently kept or deleted", () => {
    const byId = new Map(ENTRIES.map((e) => [e.id, e] as const));
    assert.equal(byId.get("outside.nat-gateway")?.class, "REVIEW");
    assert.equal(byId.get("outside.nat-gateway")?.teardown_step, "T7", "T7's evidence gate judges it (and a FAIL keeps it)");
    for (const e of ENTRIES.filter((x) => x.class === "REVIEW" && x.id !== "outside.nat-gateway")) assert.equal(e.teardown_step, undefined, `${e.id}: Phase 1 deletes no other REVIEW resource`);
    assert.equal(byId.get("outside.vpc")?.class, "REVIEW");
    assert.match(String(byId.get("outside.vpc")?.state_action), /deletes no VPC, subnet, route table or IGW/);
    const g2 = byId.get("outside.g2-table");
    assert.equal(g2?.class, "DELETE-MIGRATION");
    assert.ok((g2?.preconditions as string[]).some((p) => /APPGEN = 1/.test(p)) && (g2?.preconditions as string[]).some((p) => /no Terraform state lists it/.test(p)));
    assert.equal(byId.get("outside.container-insights-log-groups")?.class, "DELETE-LEGACY");
    assert.equal(byId.get("outside.alb-origin-dns-and-certificate")?.class, "DELETE-LEGACY");
    /* The ECS task role: deleting it invalidates nothing (account root + aws:PrincipalArn), T5 removes the name. */
    assert.match(String(byId.get("app.ecs-roles")?.principal_effect), /does NOT invalidate any ledger or KMS policy/);
    assert.match(read("infra/aws/modules/ledger/main.tf"), /GRANTS TO THE APP ACCOUNT are made to its account root with an `aws:PrincipalArn` condition/);
  });

  test("every budget item is backed by a KEEP entry; no deleted or reviewed resource carries one", () => {
    const services = (BUDGET.items as Array<{ service: string }>).map((i) => i.service);
    const kept = ENTRIES.filter((e) => e.class.startsWith("KEEP")).flatMap((e) => e.budget_items);
    for (const item of kept) assert.ok(services.includes(item), `${item} is a COST_BUDGET.json item`);
    assert.deepEqual([...new Set(kept)].sort(), [...services].sort(), "every budgeted item is a kept resource, and nothing kept is unbudgeted");
    for (const e of ENTRIES.filter((x) => !x.class.startsWith("KEEP"))) assert.deepEqual(e.budget_items, [], `${e.id} (${e.class}) is not in the steady-state budget`);
    /* R6 item 6: the projected steady state, on-demand, within the ceiling. */
    assert.ok((BUDGET.other_configurations["t4g.small on-demand (before the Savings Plan)"] as number) <= (BUDGET.hard_maximum_monthly as number));
  });

  test("the final state is what the compute-none guard requires (the inventory's values make its own fixture PASS)", () => {
    const app = INVENTORY.final_state["stacks/app"] as Obj;
    assert.equal(app.compute, "none");
    assert.equal(app.start_services, true);
    assert.deepEqual(app.pools, { p1: { primary: true } });
    assert.equal(app.generation, 1);
    assert.deepEqual(app.game_generations, [1]);
    assert.equal(app.recovery_break_glass, false);
    const p = clone(PLANS["compute-none"]) as Obj;
    for (const name of ["compute", "start_services", "pools", "recovery_break_glass"]) p.variables[name] = { value: app[name] };
    const r = judgeMigrationPlan("compute-none", p, CTX);
    assert.equal(r.verdict, "PASS", failedChecks(r).join("; "));
    const ledger = INVENTORY.final_state["stacks/ledger"] as Obj;
    assert.equal(ledger.ecs_task_role_authorized, false);
    assert.deepEqual(ledger.app_runtime_role_arns, ["arn:aws:iam::<app account>:role/gs-<env>-host-app"]);
    const host = INVENTORY.final_state["stacks/single-host"] as Obj;
    assert.equal(host.pool, "p1");
    assert.deepEqual(host.game_generations, [1]);
    assert.equal(host.manage_ecr_lifecycle, true);
    assert.deepEqual(host.emergency_ssh_cidrs, []);
  });

  test("the tooling: what the clean build reuses is RETAINED, the migration-only paths are RETIRED (kept as source)", () => {
    const status = new Map((INVENTORY.tooling as Array<{ tool: string; status: string }>).map((t) => [t.tool, t.status] as const));
    for (const kept of ["migration-guard edge-cutover (forward)", "migration-guard compute-none", "migration-guard ledger-task-deauthorize", "migration-guard ecr-lifecycle", "migration-guard nat + capture-nat-evidence"]) assert.equal(status.get(kept), "RETAINED", kept);
    assert.equal(status.get("migration-guard ecs-rollback"), "RETIRED");
    assert.equal(status.get("migration-guard edge-cutover --direction rollback"), "RETIRED");
    assert.equal(status.get("awsDeploy host-cert graceful-stop (F7)"), "RETIRED-FROM-PHASE-1");
    assert.equal(status.get("awsDeploy verify --topology coexist (F0 / 15b)"), "RETIRED-FROM-PHASE-1");
    /* Retired is not deleted: the source stays (operational / recovery tooling). */
    for (const file of ["server/src/aws/deploy/migration/planGuards.ts", "server/src/aws/deploy/hostcert/scenarios.ts", "server/src/aws/deploy/hostVerify.ts"]) assert.ok(fs.existsSync(path.join(REPO, file)), file);
    assert.match(read("server/src/aws/deploy/migration/planGuards.ts"), /case "ecs-rollback":/);
  });
});

/* ================================================================== */

describe("P1-R2: the expensive topology and the task role's grants cannot come back through an omitted line", () => {
  const appStack = stripHcl(read("infra/aws/stacks/app/variables.tf"));
  const ledgerStack = stripHcl(read("infra/aws/stacks/ledger/variables.tf"));

  test("stacks/app: `compute` has NO default; the module keeps its default and its ecs | none validation", () => {
    assert.doesNotMatch(variableBlock(appStack, "compute"), /\bdefault\s*=/, "every stacks/app plan states compute");
    assert.match(variableBlock(appStack, "compute"), /type\s*=\s*string/);
    const moduleVars = stripHcl(read("infra/aws/modules/app/variables.tf"));
    assert.match(variableBlock(moduleVars, "compute"), /default\s+=\s+"ecs"/, "the module's default is unchanged (its tests and moved addresses rely on it)");
    assert.match(variableBlock(moduleVars, "compute"), /contains\(\["ecs", "none"\], var\.compute\)/);
    assert.match(read("infra/aws/stacks/app/main.tf"), /compute\s+=\s+var\.compute/, "the root passes it through");
  });

  test("stacks/ledger: `ecs_task_role_authorized` has NO default; the module's stays true (byte-identical policies by default)", () => {
    assert.doesNotMatch(variableBlock(ledgerStack, "ecs_task_role_authorized"), /\bdefault\s*=/, "every stacks/ledger plan states it");
    assert.match(variableBlock(ledgerStack, "ecs_task_role_authorized"), /type\s*=\s*bool/);
    assert.match(variableBlock(stripHcl(read("infra/aws/modules/ledger/variables.tf")), "ecs_task_role_authorized"), /default\s+=\s+true/);
    assert.match(read("infra/aws/stacks/ledger/main.tf"), /ecs_task_role_authorized\s+=\s+var\.ecs_task_role_authorized/);
  });

  test("the examples state the final values", () => {
    const appExample = stripHcl(read("infra/aws/stacks/app/example.tfvars.example"));
    assert.match(appExample, /^compute\s*=\s*"none"\s*$/m);
    assert.match(appExample, /^pools\s*=\s*\{ p1 = \{ primary = true \} \}\s*$/m);
    const ledgerExample = stripHcl(read("infra/aws/stacks/ledger/example.tfvars.example"));
    assert.match(ledgerExample, /^ecs_task_role_authorized\s*=\s*false\s*$/m);
    assert.match(ledgerExample, /^app_runtime_role_arns\s*=\s*\["arn:aws:iam::111111111111:role\/gs-staging-host-app"\]\s*$/m);
  });

  test("since the Phase-1 base, only those two root variables, their examples and the module README moved under infra/aws/modules and infra/aws/stacks", { skip: baseAvailable ? false : `not a checkout holding the Phase-1 base ${RESET_BASE.slice(0, 7)} (a shallow clone)` }, () => {
    const r = git(["diff", "--name-only", RESET_BASE, "--", "infra/aws/modules", "infra/aws/stacks"]);
    assert.equal(r.status, 0, r.stderr);
    const allowed = new Set(["infra/aws/stacks/app/variables.tf", "infra/aws/stacks/app/example.tfvars.example", "infra/aws/stacks/ledger/variables.tf", "infra/aws/stacks/ledger/example.tfvars.example", "infra/aws/modules/single-host/README.md"]);
    assert.deepEqual(r.stdout.trim().split("\n").filter((f) => f !== "" && !allowed.has(f)), [], "no module, resource, template, host file or stacks/single-host change");
    /* Each variables.tf differs from the base ONLY by its one removed default (comments aside). */
    for (const [file, name] of [["infra/aws/stacks/app/variables.tf", "compute"], ["infra/aws/stacks/ledger/variables.tf", "ecs_task_role_authorized"]] as const) {
      const before = git(["show", `${RESET_BASE}:${file}`]);
      assert.equal(before.status, 0, before.stderr);
      const squash = (hcl: string) => stripHcl(hcl.replace(/\r\n?/g, "\n")).replace(/\s+/g, " ").trim();
      const base = squash(before.stdout);
      const block = variableBlock(stripHcl(before.stdout.replace(/\r\n?/g, "\n")), name);
      const withoutDefault = block.replace(/\n\s*default\s*=\s*[^\n]*/, "");
      assert.notEqual(withoutDefault, block, `the base declared a default for ${name}`);
      assert.equal(squash(read(file)), squash(stripHcl(before.stdout.replace(/\r\n?/g, "\n")).replace(block, withoutDefault)), `${file}: only ${name}'s default was removed`);
      assert.notEqual(squash(read(file)), base);
    }
  });
});

/* ================================================================== */

describe("P1-R3: the teardown runs in the order the guards force, forward only, an owner GO before each mutation", () => {
  test("edge-cutover requires compute = \"ecs\": the edge moves BEFORE compute-none", () => {
    assert.equal(judgeMigrationPlan("edge-cutover", clone(PLANS["edge-cutover"]), CTX).verdict, "PASS");
    const p = clone(PLANS["edge-cutover"]) as Obj;
    p.variables.compute = { value: "none" };
    const r = judgeMigrationPlan("edge-cutover", p, CTX);
    assert.equal(r.verdict, "FAIL");
    assert.ok(failedChecks(r).includes("variables: still compute = ecs, break-glass off"), failedChecks(r).join("; "));
  });

  test("compute-none forbids any distribution change: the edge cannot move inside or after the teardown's own plan", () => {
    assert.equal(judgeMigrationPlan("compute-none", clone(PLANS["compute-none"]), CTX).verdict, "PASS");
    const p = clone(PLANS["compute-none"]) as Obj;
    const edge = clone((PLANS["edge-cutover"] as Obj).resource_changes as Obj[]).find((c) => c.address === "module.app.aws_cloudfront_distribution.site[0]");
    assert.ok(edge, "the edge fixture moves the distribution");
    p.resource_changes = [...(p.resource_changes as Obj[]).filter((c) => c.address !== edge.address), edge];
    const r = judgeMigrationPlan("compute-none", p, CTX);
    assert.equal(r.verdict, "FAIL");
    assert.ok(failedChecks(r).includes("the serving tables and the edge: untouched"), failedChecks(r).join("; "));
  });

  test("the procedure: T0 read-only, then T1 edge-cutover < T3 compute-none < T5 ledger-task-deauthorize < T7 the NAT gate; no rollback anywhere", () => {
    const at = (marker: string) => {
      const i = TEARDOWN.indexOf(marker);
      assert.ok(i >= 0, `the teardown has ${marker}`);
      return i;
    };
    const order = ["## T0 ", "## T1 ", "migration-guard edge-cutover", "## T2 ", "## T3 ", "migration-guard compute-none", "## T4 ", "## T5 ", "migration-guard ledger-task-deauthorize", "## T6 ", "## T7 ", "capture-nat-evidence", "migration-guard nat", "## T8 ", "## T9 "].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the steps appear in their forced order");
    assert.doesNotMatch(TEARDOWN, /ecs-rollback|--direction rollback|--topology coexist/, "no rollback path, no coexistence");
    assert.match(TEARDOWN, /\*\*Never from Cowork\.\*\*/);
    assert.match(TEARDOWN, /T0 is read-only and needs no GO\. \*\*Every mutation needs its own explicit owner GO, consumed immediately before that\s+mutation\.\*\*/);
    for (const go of ["GO-T1", "GO-T2", "GO-T3", "GO-T4", "GO-T5", "GO-T6", "GO-T7"]) assert.match(TEARDOWN, new RegExp(`\\| ${go} \\| \`GO P1-R3 `), `${go} has its exact text`);
    /* Every guard is judged into a record before its apply; the applies are the judged saved plans. */
    for (const step of ["t1", "t3", "t5"]) assert.match(TEARDOWN, new RegExp(`apply <D>\\\\teardown\\\\${step}\\\\terraform\\\\(app|ledger)\\\\stack\\.tfplan`), `${step} applies exactly its judged plan`);
    /* The ALB unprotect exists only in T2, only when T0 read true. */
    const t2 = TEARDOWN.slice(at("## T2 "), at("## T3 "));
    assert.match(t2, /only if T0\.6 read `true`/);
    assert.equal(TEARDOWN.split("modify-load-balancer-attributes").length - 1, 1, "one unprotect command, in T2");
    assert.ok(TEARDOWN.indexOf("modify-load-balancer-attributes") > at("## T2 ") && TEARDOWN.indexOf("modify-load-balancer-attributes") < at("## T3 "));
  });

  test("T7 keeps the NAT gate's rules: the unchanged guard, >= 24 whole hours, the capture >= 24 h AFTER T3, a FAIL keeps the NAT", () => {
    const t7 = TEARDOWN.slice(TEARDOWN.indexOf("## T7 "), TEARDOWN.indexOf("## T8 "));
    assert.match(t7, />= 24 whole\s+hours, all zero/);
    /* The post-T3 routing (the gateway endpoints gone from the shared route tables) is always observed for >= 24 h. */
    assert.match(t7, /\*\*The capture runs no earlier than 24 whole hours after T3's recorded apply time, whatever T_anchor is\.\*\*/);
    assert.match(t7, /1\. At or after ceil_hour\(T3\) \+ 24 h[^\n]*\n[^\n]*\n\s+`infra\\aws\\scripts\\capture-nat-evidence\.ps1/);
    assert.match(t7, /check that `capture\.json`'s `metrics_end` ≥ T3's apply time\s+\(`t3-applied-at\.txt`\) rounded UP to the hour, plus 24 h/);
    assert.match(t7, /\*\*T_anchor = T_drain\*\* when T0\.10 proved it, otherwise T3's recorded apply time/);
    assert.match(t7, /COST-2B NAT DELETION EVIDENCE: PASS/);
    assert.match(t7, /\*\*A FAIL keeps the NAT\.\*\*/);
    assert.doesNotMatch(TEARDOWN, /--min-quiet-hours/, "the quiet minimum is never lowered");
    assert.match(read("server/src/aws/deploy/migration/migrationCommands.ts"), /minQuietHours < 24/, "the CLI refuses a minimum below 24 hours");
    /* T_drain is proven against standalone tasks too (the probes' RunTask), or T7 anchors at T3. */
    const t0 = TEARDOWN.slice(TEARDOWN.indexOf("## T0 "), TEARDOWN.indexOf("## T1 "));
    assert.match(t0, /aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunTask --start-time <T_drain>/);
    assert.match(t0, /T7 then anchors at T3/);
  });

  test("the irreversible steps are never batched: GO-T3 / T6 / T7 / T8 each in its own message, after their evidence; T0 exports first", () => {
    const boundary = TEARDOWN.slice(TEARDOWN.indexOf("## The OWNER-GO boundary"), TEARDOWN.indexOf("## T0 "));
    assert.match(boundary, /\*\*Batchable \(reversible\):\*\* GO-T1, GO-T2, GO-T4 and GO-T5/);
    assert.match(boundary, /\*\*Never batched \(irreversible\):\*\* GO-T3, GO-T6, GO-T7 and each GO-T8a–d come in their OWN owner message/);
    assert.match(TEARDOWN, /5\. \*\*GO-T3\*\* -- its own owner message, after step 4 -- then/);
    assert.match(TEARDOWN, /0\.8 \*\*Evidence that T3 and T5 destroy\*\* -- REQUIRED, unless the owner records a decision to discard an item\./);
    for (const kept of ["filter-log-events --log-group-name /gs/staging/p1", "describe-alarm-history", "stacks/app state pull", "stacks/ledger state pull"]) assert.ok(TEARDOWN.includes(kept), kept);
    /* compute-none leaves the skip_destroy task definitions ACTIVE: T8d deregisters them and T9 proves it. */
    assert.match(read("infra/aws/modules/app/ecs.tf"), /skip_destroy\s+=\s+true/);
    assert.equal(TEARDOWN.split("list-task-definitions --family-prefix gs-staging-p --status ACTIVE").length - 1, 2, "listed in T8d and checked in T9");
    assert.equal(ENTRIES.find((e) => e.id === "app.ecs-task-definitions")?.teardown_step, "T8");
  });
});

/* ================================================================== */

describe("P1-R5: the direct final-system certification", () => {
  const required = (() => {
    const from = PLAN.indexOf("**REQUIRED before Phase 2:**");
    const to = PLAN.indexOf("**Order:**", from);
    assert.ok(from > 0 && to > from, "the plan has the REQUIRED table and its order");
    return PLAN.slice(from, to);
  })();
  const rows = required.split("\n").filter((l) => /^\| [A-Z][0-9]? \|/.test(l));

  test("the REQUIRED rows are A–F (+ the closure record Z), each with its tool and PASS criterion", () => {
    assert.deepEqual(rows.map((l) => /^\| ([A-Z][0-9]?) \|/.exec(l)?.[1]), ["A1", "B1", "B2", "B3", "B4", "B5", "C1", "C2", "C3", "C4", "D1", "D2", "D3", "E1", "E2", "E3", "F1", "Z"]);
    for (const l of rows) assert.equal(l.split(" | ").length, 4, `four columns: ${l.slice(0, 40)}`);
  });

  test("they name the final-system tools -- and none of the retired migration gates", () => {
    const text = rows.join("\n");
    for (const tool of ["verify --topology single-host", "stage-probe edge --topology single-host", "host-cert crash-restart", "host-cert reboot-restart", "host-cert duplicate-preflight", "host-cert duplicate-fence", "role-probe -Probe kms", "role-probe -Probe transactions", "set-operator-plan", "--to-relayer", "gamesDoctor aws status", "orphans", "money <game> --chain"]) assert.ok(text.includes(tool), tool);
    for (const retired of ["graceful-stop", "--topology coexist", "ecs-rollback", "replacement-before", "replacement-after", "--direction rollback", "--gs-origin"]) assert.ok(!text.includes(retired), `${retired} is not a Phase-1 requirement`);
  });

  test("E2 is a money smoke on the escrow the host already serves -- no key, contract, frontend or stack change; one GO per money step", () => {
    const e2 = PLAN.slice(PLAN.indexOf("**E2 -- the controlled money smoke**"), PLAN.indexOf("**Owner GO for the drills and probes.**"));
    assert.ok(e2.length > 0);
    assert.match(e2, /It is NOT the Phase-2 pack's Session 1/);
    assert.match(rows.find((l) => l.startsWith("| E2 |")) ?? "", /no KMS key, contract, document, frontend or stack change/);
    for (const go of ["CreateGame", "Join", "Start", "final move", "consent"]) assert.ok(e2.includes(`\`GO P1-R5 E2 ${go}\``), go);
    assert.match(e2, /never batched with the drills/);
  });

  test("R5 may proceed during T7's wait only with the pending NAT marked PROVISIONAL; the closure record Z never carries one", () => {
    assert.match(PLAN, /A1 then names that NAT with `--allow-nat <nat-\.\.\.>`, marked \*\*PROVISIONAL\*\* in the record/);
    const z = rows.find((l) => l.startsWith("| Z |")) ?? "";
    assert.match(z, /after E2, every drill and T7/);
    assert.match(z, /never a provisional one/);
    assert.match(PLAN, /R5's Z record is `VERIFIED` \(no provisional `--allow-nat`\), and T9 is\s+recorded in full/);
  });

  test("the acceptance rule's availability-only checks are the drills' own check names; everything safety-relevant must PASS", () => {
    const rule = PLAN.slice(PLAN.indexOf("**Accepting a host-cert record.**"), PLAN.indexOf("**Reclassified to Phase 6 / 7"));
    assert.ok(rule.length > 0);
    const scenarios = read("server/src/aws/deploy/hostcert/scenarios.ts");
    const hostState = read("server/src/aws/deploy/hostcert/hostState.ts");
    assert.match(rule, /`F7: readiness goes unavailable first`/);
    assert.ok(scenarios.includes('"F7: readiness goes unavailable first"'), "the F7 sampler's check name");
    assert.match(rule, /`<label>: systemd's journal agrees with ExecStopPost`/);
    assert.ok(hostState.includes("`${label}: systemd's journal agrees with ExecStopPost`"), "the journal check's name");
    assert.match(rule, /`<label>: systemd passes EXIT_CODE \/ EXIT_STATUS to ExecStopPost` check PASSED/);
    assert.ok(hostState.includes("`${label}: systemd passes EXIT_CODE / EXIT_STATUS to ExecStopPost`"), "the exit-status check's name");
    assert.match(rule, /Every other check of that record must PASS/);
    assert.match(rule, /Any FAIL is a STOP/);
  });

  test("the availability-only observations are reclassified to Phase 6 / 7, never Phase-1 blockers", () => {
    const later = PLAN.slice(PLAN.indexOf("**Reclassified to Phase 6 / 7"), PLAN.indexOf("## 8. P1-R6"));
    for (const item of [/transient readiness 503 in a 200 ms sampling interval/, /journal's wording for a clean exit 0/, /zero-downtime deploy or handoff/, /migration rollback/, /old \/ new pool coexistence/]) assert.match(later, item);
  });
});

/* ================================================================== */

describe("P1-R0 / P1-R6: the governing plan and its pointers", () => {
  test("SINGLE_HOST_MIGRATION.md is RETIRED as the governing plan, its body unchanged below the banner", () => {
    const head = BOOK.slice(0, BOOK.indexOf("**Status:** a PLAN."));
    assert.match(head, /^# Migrating staging from the drained ECS topology to the single host/);
    assert.match(head, /\*\*RETIRED AS THE GOVERNING PHASE-1 PLAN \(PHASE 1 CLEAN-BUILD RESET, 2026-10-04\)\.\*\*/);
    assert.match(head, /\*\*`infra\/aws\/PHASE1_CLEAN_BUILD\.md`\*\*/);
    assert.match(head, /Do not execute it as a sequence\./);
  });

  test("the canonical context, the budget record and the READMEs point at the governing plan", () => {
    const context = read("PROJECT_CANONICAL_CONTEXT.md");
    assert.match(context.split("\n").find((l) => l.startsWith("**Last updated:**")) ?? "", /PHASE 1 CLEAN-BUILD RESET/);
    assert.match(context, /\*\*The governing plan is `infra\/aws\/PHASE1_CLEAN_BUILD\.md`:\*\*/);
    assert.match(read("docs/hosting-budget.md"), /`infra\/aws\/PHASE1_CLEAN_BUILD\.md`/);
    assert.match(read("infra/aws/README.md"), /the governing Phase-1 plan is `infra\/aws\/PHASE1_CLEAN_BUILD\.md`/);
    assert.match(read("infra/aws/modules/single-host/README.md"), /`infra\/aws\/PHASE1_CLEAN_BUILD\.md`/);
  });

  test("the plan carries P1-R0 … P1-R6; closure is six criteria, Cost Explorer trails and never blocks, $30 stays the ceiling", () => {
    for (const m of ["P1-R0", "P1-R1", "P1-R2", "P1-R3", "P1-R4", "P1-R5", "P1-R6"]) assert.match(PLAN, new RegExp(`\\| \\*\\*${m}\\*\\* \\|`), m);
    const closure = PLAN.slice(PLAN.indexOf("## 8. P1-R6"), PLAN.indexOf("## 9. "));
    assert.deepEqual([...closure.matchAll(/^([1-6])\. \*\*/gm)].map((m) => m[1]), ["1", "2", "3", "4", "5", "6"]);
    assert.match(closure, /\*\*Trailing confirmation, never a gate:\*\* Cost Explorer daily for 5–7 days/);
    assert.match(closure, /above \$30 \/ month reopens the cost issue/);
    assert.equal(BUDGET.hard_maximum_monthly, 30);
    assert.match(PLAN, /no coexistence\s+proof and no zero-downtime property is required/i);
  });

  test("this suite runs in `npm test` and in the owner gate's PHASE-1 targeted gate", () => {
    const pkg = JSON.parse(read("server/package.json")) as { scripts: Record<string, string> };
    assert.ok(pkg.scripts.test.includes("dist/server/src/aws/deploy/migration/phase1CleanBuild.test.js"), "npm test");
    const gate = read("infra/aws/single-host/run-cost2c-owner-gate.ps1");
    const phase1 = gate.slice(gate.indexOf("Add-Gate 'PHASE-1 targeted' "), gate.indexOf("Add-Gate 'PHASE-1 targeted (Linux)'"));
    assert.ok(phase1.includes("'aws/deploy/migration/phase1CleanBuild.test.js'"), "the owner gate");
  });
});
