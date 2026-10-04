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
//   external   (PHASE 1 EXTERNAL-STACK INVENTORY AMENDMENT) staging Terraform stacks whose configuration is NOT in this
//              repository: the rpc-proxy stack is KEEP-DURABLE and no teardown step can touch it; the network stack is
//              REVIEW with its state key recorded; every known state is listed and mapped; R1 stops on an unknown
//              state; the VPC / subnets / route tables / IGW are never deleted; T7 never deletes a Terraform-owned NAT
//              directly and BLOCKS on unproven ownership
//   T3 fast    (owner priority) T3 is the critical path: T0 is tagged [PRE-T3] / [CAPTURE BEFORE T3] / [AFTER T3 OK];
//              nothing about the NAT, the network stack's ownership or a later step is a T3 precondition; T1 (and T2
//              only if the ALB is protected) precede the judged plan; T0.12 proves no other state manages what T3
//              destroys and nothing hangs on it; READY FOR GO-T3 is posted at the earliest safe point, GO-T3 unbatched

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
/** The AWS CLI calls of one line, as "<service> <verb>" (gamesDoctor's own `aws` subcommand is not the AWS CLI). */
const awsCalls = (line: string): string[] => [...line.replace(/gamesDoctor(\.js)? aws /g, "gamesDoctor ").matchAll(/\baws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
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
      assert.ok(/^(terraform:(app|ledger|single-host)\b|external-terraform:[a-z][a-z0-9-]*$|outside-terraform:|unresolved:)/.test(e.ownership), `${e.id}: ownership ${e.ownership}`);
      /* An external Terraform stack is recorded with its state; unresolved ownership is never deleted. */
      if (e.ownership.startsWith("external-terraform:")) assert.match(String(e.state_key), /^s3:\/\/[a-z0-9.-]+\/.+\.tfstate$/, `${e.id}: its state_key`);
      if (e.ownership.startsWith("unresolved:")) assert.ok(!e.class.startsWith("DELETE"), `${e.id}: unresolved ownership is never in a delete class`);
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

  test("the NAT is REVIEW and the VPC KEEP (never deleted); g2 is deleted only after its proof; nothing outside Terraform is silently kept or deleted", () => {
    const byId = new Map(ENTRIES.map((e) => [e.id, e] as const));
    assert.equal(byId.get("outside.nat-gateway")?.class, "REVIEW");
    assert.equal(byId.get("outside.nat-gateway")?.teardown_step, "T7", "T7's evidence gate judges it (and a FAIL keeps it)");
    for (const e of ENTRIES.filter((x) => x.class === "REVIEW" && x.id !== "outside.nat-gateway")) assert.equal(e.teardown_step, undefined, `${e.id}: Phase 1 deletes no other REVIEW resource`);
    assert.equal(byId.get("outside.vpc")?.class, "KEEP-HOST", "the VPC, subnets, route tables and IGW: KEEP / NEVER DELETE, whichever stack owns them");
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

describe("P1-R1 amendment: staging Terraform stacks whose configuration is NOT in this repository", () => {
  const byId = new Map(ENTRIES.map((e) => [e.id, e] as const));
  const STATES = INVENTORY.terraform_states as { rule: string; known: Array<{ stack: string; ownership: string; key: string; configuration: string; contents: string }> };
  const RPC_STATE = "s3://gs-staging-tfstate-992163310414/gs/staging/rpc-proxy.tfstate";
  const NETWORK_STATE = "s3://gs-staging-tfstate-992163310414/gs/staging/network.tfstate";
  const RPC_IDS = ["E271XZAA1MQR4H", "87caeb33-3047-4fd6-9d43-13a84cde1f30", "b5ed161f-d059-4e48-b706-abef86b0954c"];
  const mentionsRpc = (text: string) => /rpc-proxy|E271XZAA1MQR4H|87caeb33-3047|b5ed161f-d059|uni7-rpc/.test(text);

  test("rpc-proxy: KEEP-DURABLE, external Terraform, its state key, its distribution and both policies named, never torn down", () => {
    const rpc = byId.get("external.rpc-proxy");
    assert.ok(rpc, "the rpc-proxy stack is classified");
    assert.equal(rpc.class, "KEEP-DURABLE");
    assert.equal(rpc.ownership, "external-terraform:rpc-proxy");
    assert.equal(rpc.state_key, RPC_STATE);
    const names = (rpc.live_names as string[]).join("\n");
    for (const id of [...RPC_IDS, "gs-staging-uni7-rpc-origin-request", "gs-staging-uni7-rpc-cors", "d3d68n2c5eingb.cloudfront.net"]) assert.ok(names.includes(id), id);
    assert.match(String(rpc.what), /juno\.rpc\.t\.stavr\.tech/);
    assert.match(String(rpc.what), /pin-final\.json/);
    assert.equal(rpc.teardown_step, undefined);
    /* No entry that names the proxy may sit in a delete class. */
    for (const e of ENTRIES.filter((x) => mentionsRpc(JSON.stringify(x)))) assert.ok(!e.class.startsWith("DELETE"), `${e.id} names the rpc-proxy and is ${e.class}`);
    assert.ok(ENTRIES.filter((x) => x.ownership === "external-terraform:rpc-proxy").every((x) => x.class === "KEEP-DURABLE"));
  });

  test("network: REVIEW / external Terraform, its state key recorded, its contents deliberately UNKNOWN, never torn down", () => {
    const net = byId.get("external.network-stack");
    assert.ok(net);
    assert.equal(net.class, "REVIEW");
    assert.equal(net.ownership, "external-terraform:network");
    assert.equal(net.state_key, NETWORK_STATE);
    assert.deepEqual(net.resources, []);
    assert.match((net.live_names as string[]).join(" "), /UNKNOWN until R1 enumerates network\.tfstate/);
    assert.equal(net.teardown_step, undefined);
    /* What it may own keeps its Phase-1 class: the VPC family KEEP, the NAT REVIEW -- both unresolved until R1. */
    assert.ok(byId.get("outside.vpc")?.class.startsWith("KEEP"));
    assert.equal(byId.get("outside.nat-gateway")?.class, "REVIEW");
    for (const id of ["outside.vpc", "outside.nat-gateway"]) assert.match(String(byId.get(id)?.ownership), /^unresolved:.*external-terraform:network/, id);
  });

  test("every known staging state is listed and mapped both ways; the list is not a closed count", () => {
    const stacks = STATES.known.map((x) => x.stack);
    assert.equal(new Set(stacks).size, stacks.length, "each state once");
    for (const stack of ["app", "ledger", "single-host", "rpc-proxy", "network"]) assert.ok(stacks.includes(stack), `${stack} is listed`);
    assert.equal(STATES.known.find((x) => x.stack === "rpc-proxy")?.key, RPC_STATE);
    assert.equal(STATES.known.find((x) => x.stack === "network")?.key, NETWORK_STATE);
    assert.match(STATES.known.find((x) => x.stack === "network")?.contents ?? "", /^UNKNOWN until R1 enumerates it/);
    for (const st of STATES.known) {
      const owners = ENTRIES.filter((e) => e.ownership === st.ownership);
      assert.ok(owners.length > 0, `${st.stack}: an inventory entry carries ${st.ownership}`);
      if (st.ownership.startsWith("external-terraform:")) {
        assert.equal(owners.length, 1, `${st.stack}: one entry for the external stack`);
        assert.equal(owners[0].state_key, st.key, `${st.stack}: the entry's state_key is the listed key`);
        assert.match(st.configuration, /^NOT in this repository/);
      } else assert.ok(fs.existsSync(path.join(REPO, st.configuration)), `${st.stack}: its configuration is this repository's ${st.configuration}`);
    }
    /* Every external or candidate ownership the entries name is a listed state. */
    for (const e of ENTRIES) for (const m of e.ownership.matchAll(/external-terraform:([a-z][a-z0-9-]*)/g)) assert.ok(stacks.includes(m[1]), `${e.id} names the unlisted state ${m[1]}`);
    assert.match(STATES.rule, /An unlisted state is a STOP/);
    assert.match(STATES.rule, /The list is not closed/);
    assert.match(read("infra/aws/README.md"), /gs\/staging\/rpc-proxy\.tfstate/);
  });

  test("R1 enumerates EVERY staging Terraform state, records what the brief asks per external state, and STOPS on an unknown one", () => {
    assert.match(PLAN, /R1 enumerates every state object in the staging state bucket\(s\) -- every\s+`\.tfstate` key, not only the staging prefix/);
    assert.match(PLAN, /\*\*An unknown state is a STOP\*\*, exactly like an unknown resource/);
    assert.match(PLAN, /The known list is not a closed count/);
    for (const item of [/the S3 key, and whether it can be read/, /its resource addresses/, /the live resources behind them, and their inventory classification/, /the owning checkout or stack, if known/, /whether any Phase-1 teardown step proposes to mutate one of them/]) assert.match(PLAN, item);
    const prompt = PLAN.slice(PLAN.indexOf("**A. P1-R1 read-only inventory**"), PLAN.indexOf("**B. The OWNER-GO boundary for P1-R3**"));
    assert.match(prompt, /`gs\/staging\/rpc-proxy\.tfstate`/);
    assert.match(prompt, /`gs\/staging\/network\.tfstate`; an unknown state is a STOP/);
    assert.match(TEARDOWN, /A Terraform state that `PHASE1_INVENTORY\.json` `terraform_states` does not list is a STOP/);
  });

  test("no Phase-1 teardown step can touch the rpc-proxy: it is only READ, and nothing mutates a CloudFront resource but T1's guarded app plan", () => {
    assert.match(TEARDOWN, /\*\*External Terraform stacks are never touched\.\*\*/);
    const commands = [...TEARDOWN.matchAll(/`(aws [^`]+)`/g)].map((m) => m[1]);
    for (const c of commands.filter(mentionsRpc)) assert.match(c, /^aws (cloudfront get-distribution|s3api head-object) /, `a read only: ${c}`);
    assert.ok(commands.some((c) => c.startsWith("aws cloudfront get-distribution --id E271XZAA1MQR4H")), "T0.11 / T9 read it");
    /* Every AWS CLI call ANYWHERE in the teardown and the plan -- inline or in a fenced block -- by its service and verb. */
    for (const [name, doc] of [["TEARDOWN", TEARDOWN], ["PLAN", PLAN]] as const) {
      for (const line of doc.split("\n")) {
        const calls = awsCalls(line);
        for (const call of calls) {
          assert.ok(!/^cloudfront (create|update|delete|tag|untag|associate|disassociate|copy)-/.test(call), `${name}: no direct CloudFront mutation anywhere: ${line.trim()}`);
          assert.ok(!/^s3 (mv|rm|sync)$|^s3api (put|delete|copy|restore|create)-/.test(call), `${name}: no state object is written: ${line.trim()}`);
          /* The one s3 copy allowed streams a state object to stdout (T0.11's read form): never a write, never a saved state. */
          if (call === "s3 cp") assert.match(line, /aws s3 cp s3:\/\/[^\s`]+ - \| jq -r '[^']*@tsv'/, `${name}: aws s3 cp only as the streaming read: ${line.trim()}`);
        }
        if (mentionsRpc(line)) for (const call of calls) assert.match(call, /^(cloudfront get-distribution|s3api head-object|s3api list-objects-v2|s3 cp)$/, `${name}: a line naming the rpc-proxy only READS: ${line.trim()}`);
      }
    }
    for (const step of ["## T1 ", "## T2 ", "## T3 ", "## T4 ", "## T5 ", "## T6 ", "## T7 ", "## T8 "]) {
      const from = TEARDOWN.indexOf(step);
      const next = TEARDOWN.indexOf("\n## ", from + 1);
      const body = TEARDOWN.slice(from, next);
      const named = body.split("\n").filter(mentionsRpc);
      if (step === "## T1 ") assert.ok(named.length === 1 && /lives in another state, so it can never appear in it/.test(named[0]), `T1 names it only to exclude it: ${named.join(" / ")}`);
      else assert.deepEqual(named, [], `${step.trim()} names the rpc-proxy`);
    }
    assert.match(TEARDOWN, /the rpc-proxy distribution `E271XZAA1MQR4H` lives in another state, so it can never appear in it/);
    const t9 = TEARDOWN.slice(TEARDOWN.indexOf("## T9 "));
    assert.match(t9, /\| rpc-proxy \| `aws cloudfront get-distribution --id E271XZAA1MQR4H [^|]*\| T0\.11's answer, unchanged/);
  });

  test("T7: ownership first -- a Terraform-owned NAT is never deleted directly; unproven ownership BLOCKS; provisional NAT; R6 waits", () => {
    const t7 = TEARDOWN.slice(TEARDOWN.indexOf("## T7 "), TEARDOWN.indexOf("## T8 "));
    assert.match(t7, /^## T7 — The NAT gateway: ownership first, then evidence \(fail closed\)/);
    assert.match(t7, /- \*\*Terraform-owned\*\* -- the NAT or its EIP is in `network\.tfstate`, or in any other listed state:\n  - \*\*no direct AWS deletion\*\*/);
    assert.match(t7, /the deletion is a separately reviewed change against the OWNING stack/);
    assert.match(t7, /only the NAT \/ NAT-EIP removals plus the expected route-table consequences/);
    assert.match(t7, /the >= 24 h post-T3 evidence below must PASS first, and the owner's GO comes after both/);
    assert.match(t7, /- \*\*Ownership unproven\*\*[^\n]*\*\*T7 is BLOCKED\.\*\*/);
    assert.match(t7, /R5 continues, with A1 naming it PROVISIONAL/);
    assert.match(t7, /R6's final closure waits until the ownership is resolved, or until the owner explicitly amends the closure policy/);
    /* The direct deletion exists ONLY under the "proven NOT Terraform-owned" path, and the Terraform-owned path stops. */
    const only = t7.indexOf(`**ONLY on the "proven NOT Terraform-owned" path**`);
    const stop = t7.indexOf("**Terraform-owned:** STOP here.");
    assert.ok(only > 0 && stop > only, "the direct path, then the Terraform-owned STOP");
    for (const cmd of ["aws ec2 delete-nat-gateway", "aws ec2 release-address"]) {
      assert.equal(TEARDOWN.split(cmd).length - 1, 1, `${cmd}: written once`);
      const at = t7.indexOf(cmd);
      assert.ok(at > only && at < stop, `${cmd} only under the proven-not-Terraform-owned path`);
    }
    assert.match(TEARDOWN, /\| GO-T7 \| `GO P1-R3 T7 delete NAT <nat-\.\.\.> and release <eipalloc-\.\.\.> \(nat guard PASS; R1: not Terraform-owned\)` -- ONLY on T7's "proven NOT Terraform-owned" path/);
    assert.match(PLAN, /if T7 is BLOCKED \(ownership unproven\), or the NAT belongs to an external stack whose reviewed change has not run,\s+R6 waits/);
    assert.match(TEARDOWN, /0\.10 \*\*The NAT\*\*[\s\S]*?\*\*its ownership, as P1-R1 proved it from the states' contents:\*\*/);
  });

  test("the VPC, subnets, route tables and IGW are never deleted, whichever stack owns them", () => {
    const vpcWords = /\bVPC\b(?! endpoints?)|\bsubnets?\b|route tables?|internet gateway|\bIGW\b/i;
    for (const e of ENTRIES.filter((x) => x.class.startsWith("DELETE"))) {
      assert.doesNotMatch([String(e.what), ...(e.live_names as string[])].join("\n"), vpcWords, `${e.id} (${e.class}) must not name a VPC / subnet / route table / IGW`);
    }
    assert.match(TEARDOWN, /On every path, the VPC, its subnets, route tables and IGW are never deleted \(`outside\.vpc`, KEEP\)/);
    assert.ok(!/aws ec2 delete-(vpc|subnet|route-table|route|internet-gateway)\b|detach-internet-gateway/.test(TEARDOWN), "no VPC-family deletion command");
  });
});

/* ================================================================== */

describe("T3 fast path (owner priority): what must be known before T3, what may wait, and the earliest GO-T3", () => {
  const section = (from: string, to: string): string => {
    const a = TEARDOWN.indexOf(from);
    const b = TEARDOWN.indexOf(to, a + 1);
    assert.ok(a >= 0 && b > a, `the teardown has ${from} before ${to}`);
    return TEARDOWN.slice(a, b);
  };
  const FAST = section("## The T3 fast path", "## T0 ");
  const T0 = section("## T0 ", "## T1 ");
  const T3 = section("## T3 ", "## T4 ");
  const T0_ROWS = T0.split("\n").filter((l) => /^\| 0\.\d+ /.test(l)).map((l) => {
    const cells = l.split("|").map((c) => c.trim());
    return { item: cells[1], tag: cells[2], gates: cells[3] };
  });
  const PRE = T0_ROWS.filter((r) => r.tag === "`[PRE-T3]`");
  /** Everything T3 must NOT wait for: the network stack's ownership, the NAT, the later plans and phases. */
  const LATER = /NAT|network|T_drain|ledger|single-host|R4|R5|R6|T[4-9]\b|Phase-3|v13/;

  test("the section sits between the OWNER-GO boundary and T0, and runs R1 part A -> T0 part A -> T1 -> T2 (if needed) -> the judged plan -> READY FOR GO-T3 -> GO-T3", () => {
    assert.ok(TEARDOWN.indexOf("## The OWNER-GO boundary") < TEARDOWN.indexOf("## The T3 fast path") && TEARDOWN.indexOf("## The T3 fast path") < TEARDOWN.indexOf("## T0 "));
    assert.match(TEARDOWN.slice(0, TEARDOWN.indexOf("## STOP rules")), /\*\*The critical path is T3\*\*/);
    const steps = [...FAST.matchAll(/^(\d)\. (.*)$/gm)].map((m) => [Number(m[1]), m[2]] as const);
    assert.deepEqual(steps.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7], "seven numbered steps");
    const text = steps.map(([, s]) => s);
    assert.match(text[0], /^P1-R1 part A .* every `\[PRE-T3\]` item of T0, read-only/);
    assert.match(text[1], /^The owner sends GO-T1, plus GO-T2 if T0\.6 read `true`/);
    assert.match(text[2], /^T1: the targeted plan, its guard PASS, the apply, `Deployed`/);
    assert.match(text[3], /^T2, only if T0\.6 read `true`\.$/);
    assert.match(text[4], /^T3 steps 0–3: .*the guard PASS and the casualty re-check\.$/);
    assert.match(text[5], /^T3 step 4: the session posts `READY FOR GO-T3`, then waits\.$/);
    assert.match(text[6], /^GO-T3, in its own owner message; then T3 steps 5–6\.$/);
    assert.match(FAST, /\*\*T1 is a prerequisite of T3, forced by the guards\.\*\*/);
    assert.match(FAST, /\*\*T2 is a prerequisite only if T0\.6 read `true`:\*\*/);
    assert.match(FAST, /nothing here relaxes a guard, a STOP rule or a GO/);
    /* The guards really do force T1 first (the P1-R3 suite judges the fixtures); GO-T3 stays unbatched. */
    assert.match(TEARDOWN, /\*\*Never batched \(irreversible\):\*\* GO-T3,/);
    assert.match(TEARDOWN, /- for T3: `READY FOR GO-T3` \(T3 step 4\)/);
  });

  test("READY FOR GO-T3: posted only after T0 part A, T1 Deployed, T2 if needed, the guard PASS and the casualty re-check -- and nothing about the NAT or the network stack's ownership is on it", () => {
    const ready = FAST.slice(FAST.indexOf("**`READY FOR GO-T3`** is posted only when"), FAST.indexOf("**Not a T3 blocker.**"));
    assert.ok(ready.length > 0);
    const items = ready.split("\n").filter((l) => l.startsWith("- "));
    for (const need of [/every `\[PRE-T3\]` item of T0/, /T1 applied; the distribution `Deployed`; `\/gs\/readyz` 200 through the edge/, /T2 applied and read back `false` -- or skipped because T0\.6 read `false`/, /T3\.3's guard record PASS and its casualty re-check clean/, /T0\.3's money, relay and HOLD reads, repeated just before the post/, /destroy list, each line matched to an inventory `DELETE-LEGACY` Terraform entry/]) {
      assert.ok(items.some((l) => need.test(l)), `READY needs ${need}`);
    }
    for (const l of items) assert.doesNotMatch(l, LATER, `READY FOR GO-T3 waits for nothing later: ${l}`);
    assert.match(ready, /It is the earliest point the\s+owner can issue GO-T3/);
    /* The post itself is T3's step 4, after T1 and T2 -- and GO-T3 is step 5, its own message. */
    const post = TEARDOWN.indexOf("4. The session posts **`READY FOR GO-T3`**");
    assert.ok(post > TEARDOWN.indexOf("## T3 ") && post < TEARDOWN.indexOf("## T4 "), "T3 step 4 posts it");
    assert.ok(TEARDOWN.indexOf("## T1 ") < post && TEARDOWN.indexOf("## T2 ") < post);
    assert.match(T3, /The session mutates nothing further until GO-T3\./);
  });

  test("not a T3 blocker: the network stack's ownership, the NAT and its window, the ledger and single-host plans, T4-T9, R4-R6 and Phase-3", () => {
    const later = FAST.slice(FAST.indexOf("**Not a T3 blocker.**"));
    for (const item of [/the network stack's contents beyond T0\.12's overlap check/, /which stack holds the VPC, subnets, route\s+tables and IGW/, /the NAT and the NAT EIP: their ownership, tags and CloudTrail record, T_drain, and the >= 24 h window/, /the ledger state pull and the ledger plan \(T5\)/, /the single-host plan from `5b4756d`, the host's rendered configuration and its script hashes \(R4\)/, /T4–T9, R4, R5 and R6/, /Phase-3 \/ v13 work/]) assert.match(later, item);
    assert.match(later, /Each of these may stay provisionally unresolved until after T3\. Each must hold before the step it\s+names/);
  });

  test("T0 is split: every item is tagged, the [PRE-T3] set is exactly what T1-T3 depend on, and none of it waits for the NAT, the network stack's ownership or a later step", () => {
    assert.deepEqual([...new Set(T0_ROWS.map((r) => r.tag))].sort(), ["`[AFTER T3 OK]`", "`[CAPTURE BEFORE T3]`", "`[PRE-T3]`"]);
    assert.deepEqual(PRE.map((r) => r.item.split(" ")[0]), ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6", "0.7", "0.8", "0.9", "0.11", "0.12"]);
    for (const r of PRE) assert.doesNotMatch(r.item, LATER, `${r.item} is [PRE-T3] and must not wait for a later matter`);
    for (const r of PRE) assert.match(r.gates, /T1|T2|T3|every step/, `${r.item}: a [PRE-T3] item gates T1-T3`);
    const after = T0_ROWS.filter((r) => r.tag === "`[AFTER T3 OK]`").map((r) => `${r.item} -> ${r.gates}`);
    assert.deepEqual(after, ["0.8 the ledger state -> T5", "0.9 the ledger plan -> T5", "0.9 the single-host plan -> R4 item 2", "0.10 the NAT's facts, T_drain and ownership -> T7"]);
    assert.deepEqual(T0_ROWS.filter((r) => r.tag === "`[CAPTURE BEFORE T3]`").map((r) => r.item), ["0.10 the services' events; the VPC's route tables"]);
    /* Every item 0.1-0.12 of the body carries its tag, and the body's tags agree with the table. */
    const body = T0.slice(T0.indexOf("0.1 **Checkout.**"));
    const starts = [...body.matchAll(/^0\.(\d+) \*\*/gm)].map((m) => ({ n: Number(m[1]), at: m.index ?? 0 }));
    assert.deepEqual(starts.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    starts.forEach((s, i) => {
      const item = body.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : body.indexOf("**T0 part A PASSES**"));
      assert.match(item, /`\[(PRE-T3|AFTER T3 OK|CAPTURE BEFORE T3)\]`/, `0.${s.n} carries its tag`);
      if ([10].includes(s.n)) assert.doesNotMatch(item, /`\[PRE-T3\]`/, "the NAT is never a T3 precondition");
    });
    const nat = body.slice(body.indexOf("0.10 **The NAT**"), body.indexOf("0.11 **"));
    assert.match(nat, /T3 never touches it/);
    assert.ok(nat.indexOf("`[CAPTURE BEFORE T3]`") < nat.indexOf("`[AFTER T3 OK]` (before T7)"));
    assert.match(nat, /A missed capture leaves T_drain unproven \(T7 then anchors at T3\)[^.]*\. It never\s+blocks T3\./);
    const ledgerPull = T0.split("\n").find((l) => l.includes("the ledger state, at T5.0")) ?? "";
    assert.match(ledgerPull, /`\[AFTER T3 OK\]`/);
    assert.match(T0, /`\[AFTER T3 OK\]` \(before T5\) `stacks\/ledger` planned/);
    assert.match(T0, /`\[AFTER T3 OK\]` \(before R4 item 2\) `stacks\/single-host` planned/);
    assert.match(T0, /`\[PRE-T3\]` `stacks\/app` planned with the CURRENT tfvars/);
    assert.match(T0, /\*\*T0 part A PASSES\*\* when every `\[PRE-T3\]` item of 0\.1–0\.12 holds/);
    assert.match(T0, /\*\*T0 part B\*\* \(every `\[AFTER T3 OK\]` item\) must PASS before the step each names\. It never delays T1, T2 or T3\./);
  });

  test("T0 is read-only: every AWS CLI call in it (and in the fast path) reads, and no Terraform command in it writes", () => {
    for (const [name, text] of [["T0", T0], ["the fast path", FAST]] as const) {
      for (const call of text.split("\n").flatMap(awsCalls)) {
        assert.match(call, /^[a-z0-9-]+ (describe-|list-|get-|lookup-|head-|filter-)|^dynamodb query$|^s3 cp$/, `${name}: ${call} is a read`);
      }
      assert.doesNotMatch(text, /terraform\s+(-chdir=\S+\s+)?(apply|import|init|state\s+(rm|mv|push|replace-provider))\b/, `${name}: no Terraform write`);
    }
  });

  test("T0.12, the T3 casualty check: no other state manages what T3 destroys, nothing outside the app state hangs on it, and T3 repeats it on the plan's own destroy ids", () => {
    const c = T0.slice(T0.indexOf("0.12 **The T3 casualty check**"), T0.indexOf("**T0 part A PASSES**"));
    assert.ok(c.length > 0);
    assert.match(c, /\*\*No other stack manages what T3 destroys\.\*\*/);
    assert.match(c, /None of them may appear in another state's `\.tsv` \(0\.11\),\s+even inside a longer id/);
    assert.match(c, /An app-account state that cannot be\s+read is a STOP too/);
    for (const read of ["aws ec2 describe-network-interfaces --filters Name=group-id,Values=<the three>", "Name=ip-permission.group-id,Values=<the three>", "Name=egress.ip-permission.group-id", "aws ec2 describe-security-group-rules --filters Name=group-id,Values=<the three>", "aws iam list-instance-profiles-for-role --role-name gs-staging-app-task", "Role.RoleLastUsed"]) assert.ok(c.includes(read), read);
    assert.match(c, /\*\*The host does not use it\.\*\*/);
    /* T3 step 3: the same comparison on the judged plan's destroy ids; a delete is the change whose `after` is null. */
    assert.match(T3, /\*\*The casualty re-check\*\* \(read-only\), after the PASS: the ids this plan destroys,\s+`jq -r '\.resource_changes\[\] \| select\(\.change\.after == null\) \| \.change\.before\.id' <D>\\teardown\\t3\\terraform\\app\\plan\.json`/);
    assert.match(read("infra/aws/scripts/plan-evidence.ps1"), /Join-Path \$target "plan\.json"/, "plan-evidence saves plan.json beside the kept plan");
    /* The ledger stack cannot hold an app-account resource: its only provider is pinned to the ledger account. */
    assert.match(T0, /the ledger stack's state is not needed before T3 when R1 recorded a separate ledger account/);
    assert.match(read("infra/aws/stacks/ledger/main.tf"), /allowed_account_ids = \[var\.ledger_account_id\]/);
    assert.equal((read("infra/aws/stacks/ledger/main.tf").match(/^provider "aws"/gm) ?? []).length, 1, "the ledger stack has ONE aws provider");
  });

  test("T0.11: the bucket is listed again, every state is read only by the streaming addresses-and-ids form, and the rpc-proxy and the state objects are read", () => {
    const s = T0.slice(T0.indexOf("0.11 **Every Terraform state"), T0.indexOf("0.12 **"));
    assert.ok(s.length > 0);
    assert.match(s, /\(`APP-ADMIN`, read-only\)\. `\[PRE-T3\]`/);
    assert.ok(s.includes(`aws s3api list-objects-v2 --bucket gs-staging-tfstate-992163310414 --query "Contents[?ends_with(Key, '.tfstate')].[Key,ETag,LastModified]" --output text`), "the bucket's every .tfstate key, listed now");
    assert.ok(s.includes("aws s3 cp s3://gs-staging-tfstate-992163310414/<key> - | jq -r '.resources[] | . as $r | .instances[] | [$r.mode, $r.module, $r.type, $r.name, .index_key, .attributes.id] | @tsv'"), "the one read form");
    assert.match(s, /never the attributes \(which can hold secrets\)/);
    assert.ok(s.includes('aws cloudfront get-distribution --id E271XZAA1MQR4H --query "[ETag, Distribution.Status, Distribution.DistributionConfig.Origins.Items[0].DomainName]"'), "the rpc-proxy read");
    assert.ok(s.includes('aws s3api head-object --bucket gs-staging-tfstate-992163310414 --key gs/staging/rpc-proxy.tfstate --query "[ETag, LastModified]"'), "the state object's metadata");
    assert.match(TEARDOWN, /Never `terraform init` in `infra\/aws\/stacks\/\*`\s+against another stack's key, never `-migrate-state` or `-force-copy`, never a plan or apply of an external stack\./);
    assert.match(PLAN, /Never a\s+`terraform init` against another stack's key, never `-migrate-state` or `-force-copy`/);
    assert.match(String(INVENTORY.terraform_states.rule), /never terraform init in infra\/aws\/stacks\/\* against another stack's key/);
    /* T9 re-lists the objects; T1's changed distribution is the app state's own. */
    assert.match(TEARDOWN.slice(TEARDOWN.indexOf("## T9 ")), /\| state objects \| `aws s3api list-objects-v2 --bucket gs-staging-tfstate-992163310414 [^|]*\| T0\.11's keys, no new one/);
    assert.match(section("## T1 ", "## T2 "), /The id it changes \(`plan\.json`, the change's `before\.id`\) must be the one in the app\s+state's `\.tsv` \(T0\.11\) and in no other state's\./);
  });

  test("T3's removal of its own gateway endpoints' routes is not a change to the network stack; the private route tables are recorded, not a blocker", () => {
    assert.match(T3, /\*\*The private route tables\.\*\* T3 destroys this repository's own gateway endpoints \(`aws_vpc_endpoint\.gateway`, whose\s+`route_table_ids` are the private route tables\)/);
    assert.match(T3, /it is NOT a change to the network stack even if that stack holds the tables/);
    assert.match(T3, /`aws_route_table` skips `vpce-` routes/);
    assert.match(T3, /it does not block T3/);
    assert.match(read("infra/aws/modules/app/network.tf"), /^resource "aws_vpc_endpoint" "gateway" \{\n(?:[^\n]*\n){0,6}?\s+route_table_ids\s+=\s+var\.network\.private_route_table_ids$/m);
    assert.match(TEARDOWN, /T3's removal of this repository's own gateway endpoints, and with them their routes in the private route tables, is\s+not a change to the network stack/);
    assert.match(PLAN, /that is not a change to the network stack/);
    assert.match(String(ENTRIES.find((e) => e.id === "external.network-stack")?.state_action), /T3's removal of this repository's own gateway endpoints/);
  });

  test("R1 runs in two parts; a fast-path provisional placement is an owner ruling, REVIEW only, never a DELETE class", () => {
    const r1 = PLAN.slice(PLAN.indexOf("**Live confirmation"), PLAN.indexOf("## 4. P1-R2"));
    assert.match(r1, /- \*\*Part A -- before T3: what T1, T2 and T3 depend on\.\*\*/);
    assert.match(r1, /- \*\*Part B -- may follow T3\.\*\* Each item gates the later step it names/);
    const partA = r1.slice(r1.indexOf("**Part A"), r1.indexOf("**Part B"));
    assert.match(partA, /T0\.12's\s+casualty check/);
    assert.doesNotMatch(partA, /T_drain|user agent|single-host plan|ledger plan|rendered configuration/, "part A waits for nothing T3 does not need");
    const partB = r1.slice(r1.indexOf("**Part B"));
    for (const item of [/members of `network\.tfstate`, their tags and\s+CloudTrail's user agent \(T7\)/, /which state, if any, holds the VPC, subnets, route tables and IGW, and whether the private route tables are\s+network-owned/, /the ledger plan of T0\.9 \(T5\)/, /the single-host plan of T0\.9 \(R4\)/]) assert.match(partB, item);
    assert.match(r1, /\*\*T3 fast path only\.\*\* An owner ruling recorded in the R1 record may place a newly found state or resource\s+provisionally, as REVIEW and never in a DELETE class/);
    assert.match(String(INVENTORY.terraform_states.rule), /for the T3 fast path an owner ruling may first place it provisionally as REVIEW/);
    const prompt = PLAN.slice(PLAN.indexOf("**A. P1-R1 read-only inventory**"), PLAN.indexOf("**B. The OWNER-GO boundary for P1-R3**"));
    assert.ok(prompt.indexOf("**Part A, before T3**") > 0 && prompt.indexOf("**Part B, after T3 if need be**") > prompt.indexOf("**Part A, before T3**"));
  });

  test("the review's wording fixes: GO-T7 only on the proven-not-owned path, Z's owner exception, the NAT's ownership evidence, no unproven cost claim", () => {
    const boundary = TEARDOWN.slice(TEARDOWN.indexOf("## The OWNER-GO boundary"), TEARDOWN.indexOf("## The T3 fast path"));
    assert.match(boundary, /- for T7: R1's ownership answer, the NAT evidence PASS, and the owner's RAM \/ no-planned-workload confirmation\. GO-T7\s+exists only on T7's "proven NOT Terraform-owned" path\. A Terraform-owned NAT's removal has its own GO, which names\s+the reviewed external plan and never uses GO-T7's text/);
    assert.match(PLAN, /GO-T7 follows R1's ownership answer, the NAT evidence PASS/);
    assert.match(PLAN, /A\s+Terraform-owned NAT's removal has its own GO, which names the reviewed external plan and never uses GO-T7's text/);
    assert.match(PLAN, /`--allow-nat` only for a NAT T7 kept as another workload's, or one named by the owner's recorded closure-policy amendment, never a provisional one/);
    const nat = T0.slice(T0.indexOf("0.10 **The NAT**"), T0.indexOf("0.11 **"));
    for (const ev of ['aws ec2 describe-nat-gateways --nat-gateway-ids <nat-...> --query "NatGateways[].Tags"', 'aws ec2 describe-addresses --allocation-ids <eipalloc-...> --query "Addresses[].Tags"', "AttributeValue=CreateNatGateway", "`AllocateAddress`", "`userAgent`"]) assert.ok(nat.includes(ev), ev);
    assert.match(nat, /\*\*Proven NOT Terraform-owned\*\* needs both: neither is in a listed state, and neither carries a Terraform\s+marker/);
    assert.match(nat, /A marker that no listed\s+state's membership explains points at a state R1 has not found, so the ownership is \*\*unproven\*\*/);
    const t7 = TEARDOWN.slice(TEARDOWN.indexOf("## T7 "), TEARDOWN.indexOf("## T8 "));
    assert.match(t7, /- \*\*Proven NOT Terraform-owned\*\* -- T0\.10's standard: in no listed state, AND no Terraform marker/);
    assert.match(t7, /A Terraform marker that no listed state explains counts as unproven\./);
    assert.match(String(ENTRIES.find((e) => e.id === "outside.nat-gateway")?.state_action), /no gs:managed-by=terraform or gs:stack tag/);
    /* Nothing claims the rpc-proxy has no fixed charge before R1 has looked. */
    for (const [name, text] of [["inventory", JSON.stringify(INVENTORY)], ["hosting-budget", read("docs/hosting-budget.md")], ["PLAN", PLAN]] as const) assert.doesNotMatch(text, /no fixed charge|is not a breach/, name);
    assert.match(read("docs/hosting-budget.md"), /expected to be pay-as-you-go: P1-R1 part B confirms that it has no WAF, real-time logs or flat-rate plan/);
    assert.match(String(INVENTORY.classes["KEEP-HOST"]), /the VPC, subnets, route tables and IGW: never deleted, whichever stack owns them/);
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
    assert.match(context.split("\n").find((l) => l.startsWith("**Last updated:**")) ?? "", /PHASE 1 (CLEAN-BUILD RESET|EXTERNAL-STACK INVENTORY AMENDMENT)/);
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
