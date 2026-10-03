// server/src/aws/deploy/migration/recon1SevenATargets.test.ts
//
// ==================================================================
//  RECON-1 7A HOTFIX: STEP 7a'S TARGET CONTRACT CARRIES TERRAFORM'S REQUIRED COST-1 MOVE CLOSURE -- AND NOTHING ELSE
// ==================================================================
//
// The real pre-apply gate found step 7a impossible: on the accepted staging state (written BEFORE COST-1) Terraform refuses
// a plan targeted at the two policies alone -- "Moved resource instances excluded by targeting" -- because
// modules/app/moved.tf's thirteen moves are pending (and the three ECS-era policy documents COST-1 also gave `count` move
// implicitly). RECON-1A's contract said "exactly the two targets". Pinned here:
//
//   - Terraform's OWN refusal (terraform-real/app-read-authorize-pre-cost1.refusal.txt) names exactly the closure the
//     guard derives from the reviewed move contract, and the old two-target contract cannot be met on that state;
//   - the corrected contract: while COST-1's moves are pending, EXACTLY the two policies + those sixteen addresses; once
//     they are not, EXACTLY the two (the closure would then be broader than Terraform requires) -- a real Terraform plan
//     of the pre-COST-1 state (terraform-real/app-read-authorize-pre-cost1.json) PASSES end to end;
//   - the move contract is moved.tf's, block for block, both ways (every `count = local.ecs_one` singleton is moved);
//   - every move must be its exact transition and a no-op; the data sources read at plan time; the dependencies no-ops;
//   - the mutations a reviewer would try: a target missing / extra / repeated / aliased, an ECS service, a move that
//     changes its object, an unknown pair, a deferred data source, the desired-count correction, a widened grant, an
//     untargeted plan.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

import { readCheckoutText } from "../../../testSupport/portability";
import {
  APP_READ_CLOSURE_TARGETS,
  APP_READ_DEPENDENCIES,
  APP_READ_POLICY_TARGETS,
  BOOTSTRAP_READ_SIDS,
  COST1_DATA_COUNT_GATE,
  COST1_DATA_TARGETS,
  COST1_MOVE_TARGETS,
  COST1_SINGLETON_MOVES,
  GATE_NAMES,
  GATE_TARGETS,
  judgeMigrationPlan,
  judgeTargets,
  L62_GAME_TABLE_MOVE,
  OPERATOR_READ_SIDS,
  type MigrationContext,
} from "./planGuards";
import { migrationGuardCommand, SAVED_PLAN, SAVED_PLAN_SHA } from "./migrationCommands";
import { FIXTURE, validPlans } from "./planFixtures";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const source = (rel: string): string => readCheckoutText(path.join(REPO, rel));
const REAL_DIR = "infra/aws/fixtures/migration-plans/terraform-real";

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const A = "module.app";
const BOOT = `${A}.aws_iam_role_policy.bootstrap`;
const OPER = `${A}.aws_iam_role_policy.operator[0]`;
const GATE = "app-read-authorize" as const;

/** The real Terraform plan of the pre-COST-1 state (account 123456789012: moto's), its eighteen targets, its facts. */
const REAL_TEXT = source(`${REAL_DIR}/app-read-authorize-pre-cost1.json`);
const real = (): Obj => JSON.parse(REAL_TEXT) as Obj;
const REAL_TARGETS: readonly string[] = JSON.parse(source(`${REAL_DIR}/app-read-authorize-pre-cost1.targets.json`)) as string[];
const CTX: MigrationContext = { environment: "staging", appAccountId: "123456789012", servingGeneration: 1, pool: "p1", retiredPools: ["p2"], region: "us-east-1", ledgerTableArn: FIXTURE.ledgerTableArn };
/** RECON-1A's synthetic 7a plan: a state that already carries the [0] addresses (no move pending). */
const SYNTH_CTX: MigrationContext = { ...CTX, appAccountId: FIXTURE.appAccountId, region: FIXTURE.region };
const synth = (): Obj => clone(validPlans()[GATE]) as Obj;
/** RECON-1A's Terraform-made 7a plan (roles applied from COST-1's module: [0] addresses, no move pending). */
const realNoMoves = (): Obj => JSON.parse(source(`${REAL_DIR}/app-read-authorize.json`)) as Obj;

const failures = (p: unknown, ctx: MigrationContext = CTX) =>
  judgeMigrationPlan(GATE, p, ctx)
    .checks.filter((c) => c.status !== "pass")
    .map((c) => `${c.name}: ${c.detail}`);
function passes(p: unknown, ctx: MigrationContext = CTX): void {
  const f = failures(p, ctx);
  assert.deepEqual(f, [], f.join("\n"));
}
function rejects(p: unknown, why: RegExp, ctx: MigrationContext = CTX): void {
  const f = failures(p, ctx);
  assert.ok(f.length > 0, "the plan must be refused");
  assert.ok(f.some((t) => why.test(t)), `a failure matching ${why} expected; got:\n  ${f.join("\n  ")}`);
}
function targetsPass(targets: unknown, p: unknown): void {
  const c = judgeTargets(GATE, targets, p)!;
  assert.equal(c.status, "pass", c.detail);
}
function targetsFail(targets: unknown, p: unknown, why: RegExp): void {
  const c = judgeTargets(GATE, targets, p)!;
  assert.equal(c.status, "fail", `targets ${JSON.stringify(targets)} must be refused`);
  assert.match(c.detail, why);
}
const rc = (p: Obj, address: string): Obj => {
  const hit = (p.resource_changes as Obj[]).find((r) => r.address === address);
  assert.ok(hit, `the plan has ${address}`);
  return hit as Obj;
};
const moved = (p: Obj): Obj[] => (p.resource_changes as Obj[]).filter((r) => typeof r.previous_address === "string");

/* ------------------------------------------------------------------ */
/* 1. The old contract cannot be met on the pre-COST-1 state            */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (1): the old two-target contract is incompatible with a pre-COST-1 state", () => {
  const refusal = source(`${REAL_DIR}/app-read-authorize-pre-cost1.refusal.txt`);
  test("Terraform's own refusal of the two-target plan names EXACTLY the closure the guard derives (13 moved resources + 3 data sources)", () => {
    assert.match(refusal, /Error: Moved resource instances excluded by targeting/);
    const block = refusal.slice(refusal.indexOf("add the following additional target options:"), refusal.indexOf("Note that adding these options"));
    const demanded = [...block.matchAll(/-target="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(demanded.length, 16);
    assert.deepEqual([...demanded].sort(), [...COST1_MOVE_TARGETS, ...COST1_DATA_TARGETS].sort());
    assert.ok(!demanded.some((t) => APP_READ_POLICY_TARGETS.includes(t)), "the policies are the targets that were given");
  });
  test("each of the sixteen is NECESSARY: Terraform, without any one of them, demands exactly that one", () => {
    const lines = refusal.split("\n").filter((l) => l.startsWith("without "));
    assert.equal(lines.length, 16);
    for (const l of lines) {
      const m = /^without (\S+) -> demands -target="([^"]+)"$/.exec(l);
      assert.ok(m, l);
      assert.equal(m[1], m[2], l);
    }
    assert.deepEqual(lines.map((l) => l.split(" ")[1]).sort(), [...COST1_MOVE_TARGETS, ...COST1_DATA_TARGETS].sort());
  });
  test("the guard refuses the old two targets against the real pre-COST-1 plan, naming every missing address", () => {
    targetsFail([...APP_READ_POLICY_TARGETS], real(), new RegExp(`missing: ${[...COST1_MOVE_TARGETS, ...COST1_DATA_TARGETS].map((t) => t.replace(/[.[\]]/g, "\\$&")).join(", ")}`));
    targetsFail([...APP_READ_POLICY_TARGETS], real(), /COST-1's thirteen moves are pending/);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The corrected closure is accepted                                 */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (2): the corrected exact / minimal closure is accepted", () => {
  test("the contract constants: 2 policies + 13 moved resources + 3 data sources = 18, no duplicate, derived from the move contract", () => {
    assert.deepEqual([...APP_READ_POLICY_TARGETS], [...GATE_TARGETS[GATE]!]);
    assert.equal(APP_READ_CLOSURE_TARGETS.length, 18);
    assert.equal(new Set(APP_READ_CLOSURE_TARGETS).size, 18);
    assert.deepEqual([...COST1_MOVE_TARGETS], COST1_SINGLETON_MOVES.map(([from, to]) => {
      assert.equal(`${from}[0]`, to, "every COST-1 move is <resource> -> <resource>[0]");
      return `${A}.${from}`;
    }));
    assert.deepEqual([...COST1_DATA_TARGETS], COST1_DATA_COUNT_GATE.map((d) => `${A}.data.${d}`));
    assert.deepEqual([...REAL_TARGETS].sort(), [...APP_READ_CLOSURE_TARGETS].sort(), "the real capture's targets are the contract");
  });
  test("the real Terraform plan of the pre-COST-1 state PASSES the gate with its eighteen targets (in any order)", () => {
    passes(real());
    targetsPass([...REAL_TARGETS], real());
    targetsPass([...REAL_TARGETS].reverse(), real());
  });
  test("every other gate refuses the real 7a closure plan", () => {
    for (const other of GATE_NAMES.filter((g) => g !== GATE)) assert.equal(judgeMigrationPlan(other, real(), CTX).verdict, "FAIL", other);
  });
  test("its entries are exactly the closure Terraform built: 2 policy updates, 13 no-op moves, the roles, ECR, log groups, target groups -- no ECS service", () => {
    const entries = (real().resource_changes as Obj[]).map((r) => `${r.address} ${r.change.actions.join(",")}`).sort();
    assert.deepEqual(entries, [
      'module.app.aws_cloudwatch_log_group.pool["p1"] no-op',
      'module.app.aws_cloudwatch_log_group.pool["p2"] no-op',
      "module.app.aws_ecr_repository.server no-op",
      "module.app.aws_ecs_cluster.this[0] no-op",
      "module.app.aws_iam_role.bootstrap no-op",
      "module.app.aws_iam_role.execution[0] no-op",
      "module.app.aws_iam_role.operator[0] no-op",
      "module.app.aws_iam_role.task[0] no-op",
      "module.app.aws_iam_role_policy.bootstrap update",
      "module.app.aws_iam_role_policy.execution[0] no-op",
      "module.app.aws_iam_role_policy.operator[0] update",
      "module.app.aws_iam_role_policy.task[0] no-op",
      "module.app.aws_lb.this[0] no-op",
      "module.app.aws_lb_listener.https[0] no-op",
      "module.app.aws_lb_listener_rule.gs[0] no-op",
      'module.app.aws_lb_target_group.pool["p1"] no-op',
      'module.app.aws_lb_target_group.pool["p2"] no-op',
      "module.app.aws_security_group.alb[0] no-op",
      "module.app.aws_security_group.task[0] no-op",
      "module.app.aws_vpc_security_group_egress_rule.alb_to_tasks[0] no-op",
      "module.app.aws_vpc_security_group_ingress_rule.alb_from_cloudfront[0] no-op",
      "module.app.aws_vpc_security_group_ingress_rule.task_from_alb[0] no-op",
    ]);
    const deps = new Set([...APP_READ_DEPENDENCIES.base, ...APP_READ_DEPENDENCIES.moves]);
    for (const r of real().resource_changes as Obj[]) if (r.change.actions.join() === "no-op" && typeof r.previous_address !== "string") assert.ok(deps.has(`${r.type}.${r.name}`), `${r.address} is a declared dependency`);
  });
  test("a state with NO move pending keeps the bare contract: exactly the two policies (RECON-1A's real and synthetic 7a plans)", () => {
    for (const [p, ctx] of [[realNoMoves(), CTX], [synth(), SYNTH_CTX]] as const) {
      passes(p, ctx);
      targetsPass([...APP_READ_POLICY_TARGETS], p);
      /* Terraform accepts the eighteen there too (refusal.txt item 4) -- the guard does not: broader than required */
      targetsFail([...APP_READ_CLOSURE_TARGETS], p, /not in the contract.*no COST-1 move is pending: the two policies alone/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3 / 4. The move contract is moved.tf's; every permitted move is a no-op */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (3, 4): the thirteen moves are moved.tf's, block for block, and each is a no-op", () => {
  const movedTf = source("infra/aws/modules/app/moved.tf");
  const blocks = [...movedTf.matchAll(/^moved\s*\{\s*\n\s*from\s*=\s*(\S+)\s*\n\s*to\s*=\s*(\S+)\s*\n\s*\}/gm)].map((m) => [m[1], m[2]] as const);
  test("COST1_SINGLETON_MOVES == modules/app/moved.tf, in file order (no block more, none less)", () => {
    assert.equal((movedTf.match(/^moved\s*\{/gm) ?? []).length, blocks.length, "every moved block parsed");
    assert.deepEqual(blocks.map(([f, t]) => [f, t]), COST1_SINGLETON_MOVES.map(([f, t]) => [f, t]));
    assert.equal(blocks.length, 13);
  });
  test("the reverse direction: every managed singleton gated `count = local.ecs_one` in modules/app is one of the moves", () => {
    const dir = path.join(REPO, "infra/aws/modules/app");
    const gated: string[] = [];
    const gatedData: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".tf"))) {
      const text = source(`infra/aws/modules/app/${f}`);
      for (const m of text.matchAll(/^(resource|data)\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"\s*\{\s*\n\s*count\s*=\s*local\.ecs_one\s*\n/gm)) (m[1] === "data" ? gatedData : gated).push(`${m[2]}.${m[3]}`);
    }
    assert.deepEqual(gated.sort(), COST1_SINGLETON_MOVES.map(([from]) => from).sort());
    assert.deepEqual(gatedData.sort(), [...COST1_DATA_COUNT_GATE].sort(), "the data sources COST-1 gave count = the data closure");
  });
  test("L6-2's game-table move is tables.tf's -- and never part of 7a", () => {
    const m = /moved\s*\{\s*\n\s*from\s*=\s*(\S+)\s*\n\s*to\s*=\s*(\S+)\s*\n\s*\}/.exec(source("infra/aws/modules/app/tables.tf"));
    assert.ok(m);
    assert.deepEqual([m[1], m[2]], [...L62_GAME_TABLE_MOVE]);
    assert.ok(!APP_READ_CLOSURE_TARGETS.some((t) => t.includes("aws_dynamodb_table")));
  });
  test("the real plan carries exactly the thirteen pairs, each a no-op with its values unchanged", () => {
    const p = real();
    const pairs = moved(p).map((r) => [r.previous_address, r.address]);
    assert.deepEqual(pairs.map((x) => x.join(" -> ")).sort(), COST1_SINGLETON_MOVES.map(([f, t]) => `${A}.${f} -> ${A}.${t}`).sort());
    for (const r of moved(p)) {
      assert.deepEqual(r.change.actions, ["no-op"], r.address);
      assert.deepEqual(r.change.before, r.change.after, r.address);
    }
    const c = judgeMigrationPlan(GATE, p, CTX).checks.find((x) => x.name.startsWith("COST-1 address moves"))!;
    assert.equal(c.status, "pass");
    assert.match(c.detail, /all thirteen pending, each exactly its modules\/app\/moved\.tf transition and a no-op/);
  });
});

/* ------------------------------------------------------------------ */
/* 5 / 6 / 7. The target list: missing, extra, ECS                      */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (5, 6, 7): the target list is checked fail-closed", () => {
  test("(5) removing ANY one required target FAILS, naming it", () => {
    for (const drop of APP_READ_CLOSURE_TARGETS) {
      targetsFail(REAL_TARGETS.filter((t) => t !== drop), real(), new RegExp(`missing: ${drop.replace(/[.[\]]/g, "\\$&")}`));
    }
  });
  test("(6) adding an unrelated target FAILS -- a table, a document, a key, the edge, an arbitrary IAM resource, an unrelated data source, the game-table move, the whole module", () => {
    for (const extra of [
      `${A}.aws_dynamodb_table.identity`,
      `${A}.aws_dynamodb_table.game`,
      `${A}.aws_ssm_parameter.runtime["p1"]`,
      `${A}.aws_ssm_parameter.juno_backend[0]`,
      `${A}.aws_cloudfront_distribution.site[0]`,
      `${A}.aws_cloudfront_origin_request_policy.gs`,
      `${A}.aws_ecr_repository.server`,
      `${A}.aws_iam_role.recovery[0]`,
      `${A}.aws_iam_role_policy.recovery[0]`,
      `${A}.aws_iam_role.bootstrap`,
      `${A}.data.aws_dynamodb_table_item.routing[0]`,
      `${A}.data.aws_iam_policy_document.recovery`,
      `${A}.aws_lb_target_group.pool`,
      "module.ledger.aws_kms_key.signing",
      A,
    ]) {
      targetsFail([...REAL_TARGETS, extra], real(), new RegExp(`not in the contract \\(never a mutation authority\\): ${extra.replace(/[.[\]"]/g, "\\$&")}`));
      targetsFail([...APP_READ_POLICY_TARGETS, extra], realNoMoves(), /not in the contract/);
    }
  });
  test("(6) aliases and parsing tricks FAIL: an indexed spelling, a duplicate, a quoted or padded address, a non-string, no list", () => {
    targetsFail(REAL_TARGETS.map((t) => (t === `${A}.aws_lb.this` ? `${A}.aws_lb.this[0]` : t)), real(), /missing: module\.app\.aws_lb\.this;.*not in the contract.*module\.app\.aws_lb\.this\[0\]/);
    targetsFail([...REAL_TARGETS, REAL_TARGETS[3]], real(), /repeated: /);
    targetsFail(REAL_TARGETS.map((t, i) => (i === 0 ? `"${t}"` : t)), real(), /missing: module\.app\.aws_iam_role_policy\.bootstrap/);
    targetsFail(REAL_TARGETS.map((t, i) => (i === 5 ? ` ${t}` : t)), real(), /missing: /);
    targetsFail(REAL_TARGETS.map((t) => t.toUpperCase()), real(), /missing: /);
    targetsFail([...REAL_TARGETS.slice(1), 42], real(), /records no -target list/);
    targetsFail(undefined, real(), /records no -target list/);
    targetsFail("module.app.aws_iam_role_policy.bootstrap", real(), /records no -target list/);
  });
  test("(7) an ECS service (or task definition) target FAILS", () => {
    for (const ecs of [`${A}.aws_ecs_service.pool["p1"]`, `${A}.aws_ecs_service.pool`, `${A}.aws_ecs_task_definition.pool["p1"]`]) {
      targetsFail([...REAL_TARGETS, ecs], real(), /not in the contract/);
      targetsFail([...APP_READ_POLICY_TARGETS, ecs], realNoMoves(), /not in the contract/);
    }
  });
  test("the target contract is judged against the plan: none when the plan is unreadable (NOT EVALUATED), not for other gates", () => {
    assert.equal(judgeTargets(GATE, [...REAL_TARGETS], undefined)!.status, "not-evaluated");
    for (const other of GATE_NAMES.filter((g) => g !== GATE)) assert.equal(judgeTargets(other, [], real()), null, other);
  });
});

/* ------------------------------------------------------------------ */
/* 8 / 9. A permitted move carrying a change; an unknown pair           */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (8, 9): an approved moved target must be the exact known move AND a no-op", () => {
  const LB = `${A}.aws_lb.this[0]`;
  test("(8) a move that is an update / create / delete / replace / forget FAILS -- at the plan and at the target contract", () => {
    for (const actions of [["update"], ["create"], ["delete"], ["delete", "create"], ["create", "delete"], ["forget"]]) {
      const p = real();
      const r = rc(p, LB);
      r.change.actions = actions;
      if (actions.join() === "update") r.change.after = { ...r.change.after, idle_timeout: 4000 };
      if (actions.includes("delete")) r.action_reason = "delete_because_count_index";
      rejects(p, /aws_lb\.this -> module\.app\.aws_lb\.this\[0\].*the move also CHANGES the object/);
      targetsFail([...REAL_TARGETS], p, /neither none nor COST-1's thirteen/);
    }
  });
  test("(8) a 'no-op' whose values differ, or with an unknown value, or imported, FAILS", () => {
    const differ = real();
    rc(differ, LB).change.after = { ...rc(differ, LB).change.after, internal: true };
    rejects(differ, /the move also CHANGES the object/);
    const unknown = real();
    rc(unknown, LB).change.after_unknown = { dns_name: true };
    rejects(unknown, /the move also CHANGES the object/);
    const imported = real();
    rc(imported, LB).change.importing = { id: "arn:aws:elasticloadbalancing:x" };
    rejects(imported, /the move also CHANGES the object|nothing imported/);
  });
  test("(8, review L1) a 'no-op' move with replace_paths / an action_reason / no prior object / non-object values / a sensitivity or identity change FAILS", () => {
    const cases: Array<[(r: Obj) => void, RegExp]> = [
      [(r) => Object.assign(r, { replace_paths: [["subnets"]], action_reason: "replace_because_tainted" }), /replace_paths present/],
      [(r) => (r.action_reason = "replace_because_tainted"), /action_reason replace_because_tainted/],
      [(r) => Object.assign(r.change, { before: null, after: null }), /no prior object/],
      [(r) => Object.assign(r.change, { before: [1], after: [2] }), /no prior object/],
      [(r) => Object.assign(r.change, { before: "x", after: {} }), /no prior object/],
      [(r) => (r.change.after_sensitive = { ...r.change.before_sensitive, name: true }), /sensitivity changes/],
      [(r) => (r.change.after_identity = { arn: "arn:aws:elasticloadbalancing:other" }), /identity changes/],
    ];
    for (const [mutate, why] of cases) {
      const p = real();
      mutate(rc(p, LB));
      rejects(p, why);
      targetsFail([...REAL_TARGETS], p, /neither none nor COST-1's thirteen/);
    }
    const ok = real();
    rc(ok, LB).replace_paths = [];
    passes(ok);
  });
  test("(9) an unknown previous -> current pair FAILS: another source, another index, the game-table move, a swapped pair", () => {
    const cases: Array<[(p: Obj) => void, RegExp]> = [
      [(p) => (rc(p, LB).previous_address = `${A}.aws_lb.legacy`), /aws_lb\.legacy -> module\.app\.aws_lb\.this\[0\].*not one of modules\/app\/moved\.tf's thirteen/],
      [(p) => (rc(p, LB).previous_address = `${A}.aws_lb.this[1]`), /not one of modules\/app\/moved\.tf's thirteen/],
      [(p) => (rc(p, LB).previous_address = `${A}.aws_ecs_cluster.this`), /not one of modules\/app\/moved\.tf's thirteen/],
      [(p) => (rc(p, LB).previous_address = `module.ledger.aws_lb.this`), /not one of modules\/app\/moved\.tf's thirteen/],
      [
        (p) => {
          const t = clone(rc(p, `${A}.aws_ecs_cluster.this[0]`));
          Object.assign(t, { address: `${A}.aws_dynamodb_table.game["1"]`, type: "aws_dynamodb_table", name: "game", index: "1", previous_address: `${A}.aws_dynamodb_table.game` });
          (p.resource_changes as Obj[]).push(t);
        },
        /the L6-2 game-table move: a table is never step 7a's target/,
      ],
    ];
    for (const [mutate, why] of cases) {
      const p = real();
      mutate(p);
      rejects(p, why);
      targetsFail([...REAL_TARGETS], p, /neither none nor COST-1's thirteen/);
    }
  });
  test("a PARTIAL move set (twelve of thirteen) or a duplicated move FAILS", () => {
    const partial = real();
    partial.resource_changes = (partial.resource_changes as Obj[]).filter((r) => r.address !== LB);
    rejects(partial, /only 12 of the thirteen COST-1 moves are pending \(missing: module\.app\.aws_lb\.this\)/);
    targetsFail([...REAL_TARGETS], partial, /neither none nor COST-1's thirteen/);
    const twice = real();
    const dup = clone(rc(twice, LB));
    dup.address = `${A}.aws_lb.this[0]`;
    (twice.resource_changes as Obj[]).push(dup);
    rejects(twice, /the move appears twice|listed twice/);
  });
});

/* ------------------------------------------------------------------ */
/* 10. A data source deferred to apply                                  */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (10): the data-source closure is read at plan time", () => {
  test("the real plan: no data entry in resource_changes; the three documents declared aws_iam_policy_document", () => {
    assert.equal((real().resource_changes as Obj[]).filter((r) => r.mode === "data").length, 0);
    const c = judgeMigrationPlan(GATE, real(), CTX).checks.find((x) => x.name === "the data-source closure is read-only, at plan time")!;
    assert.equal(c.status, "pass", c.detail);
  });
  test("a required data source becoming apply-time (a deferred read) FAILS", () => {
    for (const d of COST1_DATA_COUNT_GATE) {
      const p = real();
      const [type, name] = d.split(".");
      (p.resource_changes as Obj[]).push({ address: `${A}.data.${d}[0]`, module_address: A, mode: "data", type, name, index: 0, provider_name: "registry.terraform.io/hashicorp/aws", action_reason: "read_because_dependency_pending", change: { actions: ["read"], before: null, after: {}, after_unknown: { json: true }, before_sensitive: false, after_sensitive: {} } });
      rejects(p, new RegExp(`data\\.${d.replace(/\./g, "\\.")}\\[0\\] \\[read\\] -- read at APPLY time`));
    }
  });
  test("a closure data source the configuration does not declare as aws_iam_policy_document FAILS", () => {
    const p = real();
    const mod = p.configuration.root_module.module_calls.app.module;
    mod.resources = (mod.resources as Obj[]).filter((r) => r.address !== "data.aws_iam_policy_document.task");
    rejects(p, /does not declare as aws_iam_policy_document: aws_iam_policy_document\.task/);
  });
  test("deferred_changes FAIL", () => {
    const p = real();
    p.deferred_changes = [{ reason: "provider_config_unknown", resource_change: rc(p, BOOT) }];
    rejects(p, /nothing deferred|sections/);
  });
});

/* ------------------------------------------------------------------ */
/* 11. The desired-count drift stays drift                              */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (11): ECS -- the desired-count correction 0 -> 1 FAILS; the drift stays visible as drift", () => {
  const service = (actions: string[], before: number, after: number): Obj => ({
    address: `${A}.aws_ecs_service.pool["p1"]`,
    module_address: A,
    mode: "managed",
    type: "aws_ecs_service",
    name: "pool",
    index: "p1",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: { actions, before: { name: "gs-staging-p1", desired_count: before }, after: { name: "gs-staging-p1", desired_count: after }, after_unknown: {}, before_sensitive: {}, after_sensitive: {} },
  });
  test("the correction 0 -> 1 in the closure plan FAILS, named as a RESTART", () => {
    const p = real();
    (p.resource_changes as Obj[]).push(service(["update"], 0, 1));
    rejects(p, /would RESTART module\.app\.aws_ecs_service\.pool\["p1"\]/);
    rejects(p, /outside the closure Terraform builds/);
  });
  test("an ECS service sneaking in as a NO-OP dependency is still outside the closure: FAILS", () => {
    const p = real();
    (p.resource_changes as Obj[]).push(service(["no-op"], 0, 0));
    rejects(p, /aws_ecs_service\.pool\["p1"\] \[no-op\] -- outside the closure Terraform builds for the two policies \+ COST-1's moves/);
  });
  test("the drift as resource_drift (live 0, state 1) PASSES and is named as drift, never a change", () => {
    const p = real();
    p.resource_drift = [{ ...service(["update"], 1, 0), change: { ...service(["update"], 1, 0).change } }];
    passes(p);
    const c = judgeMigrationPlan(GATE, p, CTX).checks.find((x) => x.name === "ECS untouched (the legacy desired-count drift)")!;
    assert.match(c.detail, /no ECS change; the drift Terraform saw stays drift \(module\.app\.aws_ecs_service\.pool\["p1"\] desired 1 -> live 0\)/);
  });
  test("a moved ECS-era object other than a no-op (the cluster) FAILS as an ECS change too", () => {
    const p = real();
    const r = rc(p, `${A}.aws_ecs_cluster.this[0]`);
    r.change.actions = ["update"];
    r.change.after = { ...r.change.after, setting: [{ name: "containerInsights", value: "enabled" }] };
    rejects(p, /ECS untouched/);
    rejects(p, /the move also CHANGES the object/);
  });
});

/* ------------------------------------------------------------------ */
/* 12. The two policies gain ONLY their pinned statements               */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (12): the two IAM policies may still gain ONLY their pinned read statements", () => {
  const sids = (text: string): string[] => (JSON.parse(text).Statement as Obj[]).map((s) => String(s.Sid));
  const edit = (p: Obj, address: string, f: (doc: Obj) => void): void => {
    const c = rc(p, address).change;
    const doc = JSON.parse(c.after.policy);
    f(doc);
    c.after.policy = JSON.stringify(doc);
  };
  test("in the real closure plan each policy gains exactly its statements (and nothing else changes)", () => {
    const p = real();
    for (const [address, want] of [[BOOT, BOOTSTRAP_READ_SIDS], [OPER, OPERATOR_READ_SIDS]] as const) {
      const c = rc(p, address).change;
      const added = sids(c.after.policy).filter((s) => !sids(c.before.policy).includes(s));
      assert.deepEqual(added.sort(), [...want].sort(), address);
      assert.deepEqual(sids(c.before.policy).filter((s) => !sids(c.after.policy).includes(s)), [], address);
    }
  });
  test("an extra statement, a widened grant, an existing statement moved: FAIL", () => {
    const extra = real();
    edit(extra, BOOT, (doc) => doc.Statement.push({ Sid: "HostVerifierRunCommand", Effect: "Allow", Action: "ssm:SendCommand", Resource: "*" }));
    rejects(extra, /statements this step does not add: HostVerifierRunCommand/);
    const wide = real();
    edit(wide, OPER, (doc) => (doc.Statement.find((s: Obj) => s.Sid === "LedgerJournalQuery").Action = ["dynamodb:Query", "dynamodb:Scan"]));
    rejects(wide, /LedgerJournalQuery/);
    const moved2 = real();
    edit(moved2, OPER, (doc) => (doc.Statement.find((s: Obj) => s.Sid === "LedgerRead").Action = "dynamodb:*"));
    rejects(moved2, /existing statements change: LedgerRead/);
  });
  test("a moved IAM object (the task role's policy) carrying a policy change FAILS: only the two policies mutate", () => {
    const p = real();
    const r = rc(p, `${A}.aws_iam_role_policy.task[0]`);
    r.change.actions = ["update"];
    r.change.after = { ...r.change.after, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "All", Effect: "Allow", Action: "*", Resource: "*" }] }) };
    rejects(p, /no table, document, key, edge or other IAM change/);
    rejects(p, /NOT PART OF THIS STEP/);
  });
});

/* ------------------------------------------------------------------ */
/* 13. An untargeted ordinary app plan still fails; the command, end to end */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX (13): an untargeted ordinary app plan still FAILS; the command end to end", () => {
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  function evidence(planText: string, targets: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon1-7a-"));
    fs.writeFileSync(path.join(dir, "plan.json"), planText);
    fs.writeFileSync(path.join(dir, "plan-exitcode.txt"), "2\n");
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ terraform_version: "1.16.5", provider_selections: { "registry.terraform.io/hashicorp/aws": "6.66.0" } }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ format: "18COSMOS/L6-6-PLAN/v1", run_id: "recon1-7a-test", stack: "app", commit: "ad135a080fec601106a42884648e29d203026e17", infra_aws_clean: true, ...(targets === undefined ? {} : { targets }) }));
    const binary = Buffer.from("binary 7a plan");
    fs.writeFileSync(path.join(dir, SAVED_PLAN), binary);
    fs.writeFileSync(path.join(dir, SAVED_PLAN_SHA), `${sha(binary)}  ${SAVED_PLAN}\n${sha(Buffer.from(planText))}  plan.json\n`);
    return dir;
  }
  const run = async (dir: string) => {
    const lines: string[] = [];
    const code = await migrationGuardCommand([GATE, "--plan-evidence", dir, "--environment", "staging", "--app-account", CTX.appAccountId, "--region", CTX.region!, "--ledger-table-arn", CTX.ledgerTableArn!], (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  test("the real closure evidence PASSES the command (exit 0) with the eighteen targets", async () => {
    const ok = await run(evidence(REAL_TEXT, [...REAL_TARGETS]));
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /PASS  evidence: the plan is targeted at exactly the step's resources: run\.json targets exactly 18/);
    assert.match(ok.text, /COST-2B MIGRATION GUARD app-read-authorize: PASS/);
  });
  test("the same evidence with the OLD two targets, none, or the whole module FAILS (exit 1, DO NOT APPLY)", async () => {
    for (const [targets, why] of [
      [[...APP_READ_POLICY_TARGETS], /missing: module\.app\.aws_lb\.this/],
      [[], /targets nothing \(an UNTARGETED plan\)/],
      [undefined, /records no -target list/],
      [[A], /not in the contract \(never a mutation authority\): module\.app/],
    ] as Array<[unknown, RegExp]>) {
      const r = await run(evidence(REAL_TEXT, targets));
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, why);
      assert.match(r.text, /DO NOT APPLY/);
    }
  });
  test("an untargeted ordinary app plan (every ECS-era object, the drift corrected, the grants) FAILS at the plan as well", () => {
    const d0 = clone(validPlans()["ecs-rollback"]) as Obj;
    for (const r of d0.resource_changes as Obj[]) if (r.type === "aws_ecs_service") Object.assign(r.change, { actions: ["update"], before: { ...r.change.before, desired_count: 0 }, after: { ...r.change.before, desired_count: 1 } });
    const f = failures(d0, SYNTH_CTX);
    assert.ok(f.some((t) => /would RESTART module\.app\.aws_ecs_service\.pool\["p1"\]/.test(t)), f.join("\n"));
    assert.ok(f.some((t) => /outside the closure Terraform builds/.test(t)), f.join("\n"));
    targetsFail([], d0, /UNTARGETED/);
  });
});

/* ------------------------------------------------------------------ */
/* The runbook carries the contract                                      */
/* ------------------------------------------------------------------ */

describe("RECON-1 7A HOTFIX: the runbook's step 7a is the contract, word for word", () => {
  const book = source("infra/aws/SINGLE_HOST_MIGRATION.md");
  const s7a = book.slice(book.search(/^7a\. `APP-ADMIN`/m), book.search(/^7b\. `LEDGER-ADMIN`/m));
  test("both capture commands carry EXACTLY the eighteen targets, once each", () => {
    const ps = s7a.split("\n").find((l) => l.includes("plan-evidence.ps1"))!;
    const sh = s7a.split("\n").find((l) => l.includes("plan-evidence.sh"))!;
    for (const lineText of [ps, sh]) {
      const got = [...lineText.matchAll(/-target=([^"' ]+)/g)].map((m) => m[1]);
      assert.equal(got.length, 18, lineText);
      assert.deepEqual([...got].sort(), [...APP_READ_CLOSURE_TARGETS].sort());
    }
  });
  test("it states the safety property: the policies the only mutations; moves no-op; data plan-time; the guard proves it; no ordinary apply; drift untouched", () => {
    assert.match(s7a, /\*\*The two IAM policies are the ONLY semantic mutations\.\*\*/);
    assert.match(s7a, /\*\*The COST-1 moved addresses accompany them solely as no-op state-address moves\*\*/);
    assert.match(s7a, /\*\*The data-source closure is read-only, at plan time\*\*/);
    assert.match(s7a, /\*\*The migration guard proves all of this\*\*/);
    assert.match(s7a, /\*\*Ordinary app-stack apply remains forbidden\*\*, and \*\*the ECS desired-count drift stays untouched\*\*/);
    assert.match(s7a, /Moved resource instances excluded by targeting/);
    assert.match(book, /^\| 7a \| app \(targeted\) \| `migration-guard app-read-authorize[^\n]*Terraform's required closure/m);
  });
});
