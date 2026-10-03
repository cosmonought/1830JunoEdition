// server/src/aws/deploy/migration/step9AcmeCompletion.test.ts
//
// STEP 9 ACME HOTFIX: the live step-9 apply created 17 of its 18 reviewed resources; EC2 refused the ACME HTTP-01 rule's
// description (an apostrophe). `host-create-complete` judges ONLY the plan that completes exactly that state. The focus is
// FALSE ACCEPTANCE: the exact completion plan passes -- the synthetic one (planFixtures) and one Terraform itself wrote
// (terraform-real/host-create-complete.json: the interrupted apply reproduced against local mocks) -- and every way a
// plan or its prior state could differ from "the known 17 + one ACME create" fails, by name. `host-create` stays the
// original full create: it now refuses any plan over a state that already holds host objects (at f1f3cac it accepted
// the completion plan: its no-ops satisfied the surface check).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { EC2_SG_DESCRIPTION, GATE_NAMES, GATES, judgeMigrationPlan, STEP9_COMPLETION_RESOURCE, type GateName, type MigrationContext } from "./planGuards";
import { migrationGuardCommand, SAVED_PLAN, SAVED_PLAN_SHA } from "./migrationCommands";
import { readCheckoutText } from "../../../testSupport/portability";
import { ACME_DESCRIPTION, FIXTURE, FIXTURE_DIR, hostPolicy, resourceChange, STEP9_IDS, validPlans } from "./planFixtures";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const read = (rel: string): string => readCheckoutText(path.join(REPO, rel));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const GATE: GateName = "host-create-complete";
const H = "module.host";
const ACME = `${H}.${STEP9_COMPLETION_RESOURCE}`;
const CTX: MigrationContext = { environment: FIXTURE.environment, appAccountId: FIXTURE.appAccountId, servingGeneration: 1, pool: "p1", retiredPools: ["p2"], minEcrKeepImages: 20, region: FIXTURE.region, ledgerTableArn: FIXTURE.ledgerTableArn, signingKeyArns: FIXTURE.signingKeyArns };
/* moto's STS answers 123456789012: the account of the Terraform-produced plans. */
const REAL_CTX: MigrationContext = { ...CTX, appAccountId: "123456789012" };
const PLANS = validPlans();
const synthetic = (): Obj => clone(PLANS[GATE]) as Obj;
const real = (): Obj => JSON.parse(read(`${FIXTURE_DIR}/terraform-real/host-create-complete.json`)) as Obj;
const realHostCreate = (): Obj => JSON.parse(read(`${FIXTURE_DIR}/terraform-real/host-create.json`)) as Obj;
const BOTH: ReadonlyArray<readonly [string, () => Obj, MigrationContext]> = [
  ["synthetic", synthetic, CTX],
  ["terraform-real", real, REAL_CTX],
];

const judgeOf = (gate: GateName, p: unknown, ctx: MigrationContext = CTX) => judgeMigrationPlan(gate, p, ctx);
const failures = (r: ReturnType<typeof judgeOf>) => r.checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`);
function rejects(p: unknown, why: RegExp, ctx: MigrationContext = CTX, gate: GateName = GATE): void {
  const r = judgeOf(gate, p, ctx);
  assert.equal(r.verdict, "FAIL", `${gate} must refuse this plan`);
  const text = failures(r);
  assert.ok(text.some((t) => why.test(t)), `${gate}: a failure matching ${why} expected; got:\n  ${text.join("\n  ")}`);
}

/* ---- plan surgery ---- */
const rcs = (p: Obj): Obj[] => p.resource_changes as Obj[];
const rc = (p: Obj, address: string): Obj => {
  const hit = rcs(p).find((r) => r.address === address);
  assert.ok(hit, `the plan has ${address}`);
  return hit as Obj;
};
const priorList = (p: Obj): Obj[] => {
  const out: Obj[] = [];
  const walk = (m: Obj): void => {
    if (Array.isArray(m.resources)) out.push(m);
    for (const c of (m.child_modules as Obj[] | undefined) ?? []) walk(c);
  };
  walk(p.prior_state.values.root_module);
  return out;
};
/** The prior-state entry of `address` (mutable). */
const priorOf = (p: Obj, address: string): Obj => {
  for (const m of priorList(p)) {
    const hit = (m.resources as Obj[]).find((r) => r.address === address);
    if (hit) return hit;
  }
  assert.fail(`the prior state has ${address}`);
};
const dropPrior = (p: Obj, address: string): void => {
  for (const m of priorList(p)) m.resources = (m.resources as Obj[]).filter((r) => r.address !== address);
};
const addPrior = (p: Obj, entry: Obj): void => {
  const m = priorList(p).find((x) => (x.address ?? "") === H) ?? priorList(p)[0];
  (m.resources as Obj[]).push(entry);
};
/** An object both in the state and the plan (a no-op), as Terraform would show one more existing object. */
const addExisting = (p: Obj, type: string, name: string, values: Obj, index?: string | number): void => {
  const r = resourceChange({ module: H, type, name, index, actions: ["no-op"], before: values, after: values });
  rcs(p).push(r);
  addPrior(p, { address: r.address, mode: "managed", type, name, ...(index === undefined ? {} : { index }), provider_name: "registry.terraform.io/hashicorp/aws", schema_version: 0, values });
};
const setAction = (p: Obj, address: string, actions: string[], after?: Obj | null): void => {
  const c = rc(p, address).change;
  c.actions = actions;
  if (after !== undefined) c.after = after;
  if (actions.includes("create") && actions.includes("delete")) rc(p, address).action_reason = "replace_because_cannot_update";
  if (actions.length === 1 && actions[0] === "delete") rc(p, address).action_reason = "delete_because_count_index";
};
const acmeAfter = (p: Obj): Obj => rc(p, ACME).change.after as Obj;
const sgOf = (p: Obj): string => priorOf(p, `${H}.aws_security_group.host`).values.id as string;
const variable = (p: Obj, name: string, value: unknown): void => {
  p.variables[name] = { value };
};

/* ------------------------------------------------------------------ */

describe("STEP 9 ACME HOTFIX: the description EC2 refused, and the corrected one", () => {
  test("the corrected description is EC2-valid; the apostrophe form is not", () => {
    assert.match(ACME_DESCRIPTION, EC2_SG_DESCRIPTION);
    assert.doesNotMatch("Let's Encrypt HTTP-01 only (Caddy serves the challenge and 404; never proxies on 80)", EC2_SG_DESCRIPTION);
    assert.doesNotMatch("x".repeat(256), EC2_SG_DESCRIPTION);
    for (const ok of ["a-z A-Z 0-9 ._-:/()#,@[]+=&;{}!$*", ""]) assert.match(ok, EC2_SG_DESCRIPTION);
    for (const bad of ["it's", 'a "quote"', "tab\there", "naïve", "a<b", "100%", "a?b", "a|b", "a\\b", "a~b", "a`b", "a^b", "a'b"]) assert.doesNotMatch(bad, EC2_SG_DESCRIPTION, bad);
  });
  test("the module's rule carries it exactly (the plan Terraform wrote from the fixed source says so too)", () => {
    const tf = read("infra/aws/modules/single-host/network.tf");
    const start = tf.indexOf('resource "aws_vpc_security_group_ingress_rule" "acme_http01" {');
    assert.ok(start >= 0);
    const block = tf.slice(start, tf.indexOf("\n}", start));
    /* the VALUE is pinned, not terraform fmt's alignment (cost1SingleHost.test.ts's style): any assignment whitespace */
    const descriptionLine = (value: string) => new RegExp(`^\\s*description\\s*=\\s*"${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*$`, "m");
    assert.match(block, descriptionLine(ACME_DESCRIPTION), block);
    assert.doesNotMatch(block.replace(ACME_DESCRIPTION, `${ACME_DESCRIPTION} (changed)`), descriptionLine(ACME_DESCRIPTION), "another description value must not pass");
    assert.doesNotMatch(block, descriptionLine("Let's Encrypt HTTP-01 only (Caddy serves the challenge and 404; never proxies on 80)"));
    assert.match(block, /ip_protocol\s+=\s+"tcp"\n\s+from_port\s+=\s+80\n\s+to_port\s+=\s+80\n\s+cidr_ipv4\s+=\s+"0\.0\.0\.0\/0"/);
    assert.equal(acmeAfter(real()).description, ACME_DESCRIPTION);
    assert.equal(acmeAfter(synthetic()).description, ACME_DESCRIPTION);
  });
});

describe("STEP 9 ACME HOTFIX: the exact completion plan PASSES -- and only host-create-complete", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: PASS (17 no-ops, one create)`, () => {
      const p = make();
      const r = judgeOf(GATE, p, ctx);
      assert.equal(r.verdict, "PASS", failures(r).join("\n"));
      assert.deepEqual(r.summary.changes, [`${ACME} [create]`]);
      assert.equal(rcs(p).filter((c) => c.change.actions.join() === "no-op").length, 17);
    });
    test(`${name}: refused by every other gate (host-create above all)`, () => {
      for (const other of GATE_NAMES.filter((g) => g !== GATE)) assert.equal(judgeOf(other, make(), ctx).verdict, "FAIL", other);
      rejects(make(), /the whole surface is CREATED by this plan.*already exist \(no-op\): step 9 was partially applied/, ctx, "host-create");
      rejects(make(), /the prior state holds no host resource yet/, ctx, "host-create");
    });
  }
  test("the terraform-real fixture is the shape Terraform writes for the interrupted state", () => {
    const p = real();
    assert.equal(p.terraform_version, "1.16.5");
    assert.equal(rcs(p).length, 18);
    assert.equal(acmeAfter(p).security_group_id, sgOf(p), "the existing SG's id is KNOWN at plan time (no unknown to judge)");
    assert.ok(!("resource_drift" in p) && !("deferred_changes" in p));
  });
});

describe("STEP 9 ACME HOTFIX: host-create stays the strict original full create", () => {
  test("the full create still PASSES host-create (synthetic and Terraform-real)", () => {
    for (const [p, ctx] of [[clone(PLANS["host-create"]) as Obj, CTX], [realHostCreate(), REAL_CTX]] as Array<[Obj, MigrationContext]>) {
      const r = judgeOf("host-create", p, ctx);
      assert.equal(r.verdict, "PASS", failures(r).join("\n"));
    }
  });
  test("a full host-create plan is NOT a completion", () => {
    rejects(clone(PLANS["host-create"]), /prior state: exactly the interrupted step 9.*no prior_state/);
    rejects(realHostCreate(), /prior state: exactly the interrupted step 9.*missing from the state/, REAL_CTX);
    rejects(realHostCreate(), /exactly one change: CREATE/, REAL_CTX);
  });
  test("host-create refuses ANY partially applied shape (not only the known one)", () => {
    /* half the surface already exists, the other half created */
    const p = synthetic();
    for (const c of rcs(p).slice(0, 8)) {
      c.change.actions = ["create"];
      c.change.after = c.change.before;
      c.change.before = null;
      dropPrior(p, c.address);
    }
    rejects(p, /already exist \(no-op\)/, CTX, "host-create");
    rejects(p, /the prior state holds no host resource yet/, CTX, "host-create");
    rejects(p, /missing from the state/);
  });
});

describe("STEP 9 ACME HOTFIX: the prior state must BE the interrupted step 9", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: another step-9 singleton missing from the state (and the plan creating it)`, () => {
      for (const local of ["aws_eip.host", "aws_iam_role_policy.host", "aws_cloudwatch_metric_alarm.health", "aws_budgets_budget.monthly[0]", 'aws_vpc_security_group_egress_rule.https["443"]']) {
        const p = make();
        dropPrior(p, `${H}.${local}`);
        rejects(p, new RegExp(`missing from the state: ${`${H}.${local}`.replace(/[.[\]"]/g, "\\$&")}`), ctx);
        const q = make();
        dropPrior(q, `${H}.${local}`);
        const c = rc(q, `${H}.${local}`).change;
        Object.assign(c, { actions: ["create"], after: c.before, before: null });
        rejects(q, /missing from the state/, ctx);
        rejects(q, /exactly one change: CREATE/, ctx);
      }
    });
    test(`${name}: the ACME rule already in the state (nothing to complete)`, () => {
      const p = make();
      const after = { ...acmeAfter(p), id: "sgr-0000000000000aaaa" };
      addPrior(p, { address: ACME, mode: "managed", type: "aws_vpc_security_group_ingress_rule", name: "acme_http01", provider_name: "registry.terraform.io/hashicorp/aws", schema_version: 0, values: after });
      rejects(p, /acme_http01 already exists: step 9 is complete/, ctx);
    });
    test(`${name}: an extra object in the state (a second instance / EIP / emergency SSH / ECR lifecycle)`, () => {
      const inst = make();
      addExisting(inst, "aws_instance", "standby", { ...priorOf(inst, `${H}.aws_instance.host`).values, id: "i-0bbbbbbbbbbbbbbbb" });
      rejects(inst, /not of step 9: module\.host\.aws_instance\.standby/, ctx);
      rejects(inst, /2 instance \(1\)/, ctx);
      const eip = make();
      addExisting(eip, "aws_eip", "spare", { domain: "vpc", id: "eipalloc-0bbbbbbbbbbbbbbbb" });
      rejects(eip, /2 Elastic IP \(1\)/, ctx);
      const ssh = make();
      addExisting(ssh, "aws_vpc_security_group_ingress_rule", "emergency_ssh", { ip_protocol: "tcp", from_port: 22, to_port: 22, cidr_ipv4: "203.0.113.7/32", security_group_id: sgOf(ssh) }, "203.0.113.7/32");
      rejects(ssh, /emergency SSH stays absent/, ctx);
      const ecr = make();
      addExisting(ecr, "aws_ecr_lifecycle_policy", "server", { repository: "gs-staging-server", policy: "{}" }, 0);
      rejects(ecr, /no ECR lifecycle \(step 22b\)/, ctx);
    });
    test(`${name}: a state object outside the host module; an empty state`, () => {
      const p = make();
      p.prior_state.values.root_module.resources = [{ address: "aws_s3_bucket.x", mode: "managed", type: "aws_s3_bucket", name: "x", provider_name: "registry.terraform.io/hashicorp/aws", values: {} }];
      rejects(p, /state objects outside module\.host/, ctx);
      const e = make();
      delete e.prior_state;
      rejects(e, /no prior_state/, ctx);
    });
  }
});

describe("STEP 9 ACME HOTFIX: the prior state is the REVIEWED host, wired together (prior-state spoofing)", () => {
  for (const [name, make, ctx] of BOTH) {
    const topo = /prior state: the reviewed host topology/;
    test(`${name}: the security group, the ENI, the EIP, the instance`, () => {
      const cases: Array<[string, (p: Obj) => void]> = [
        ["the ENI names another SG", (p) => (priorOf(p, `${H}.aws_network_interface.host`).values.security_groups = ["sg-0ffffffffffffffff"])],
        ["the ENI names a second SG", (p) => priorOf(p, `${H}.aws_network_interface.host`).values.security_groups.push("sg-0ffffffffffffffff")],
        ["the 443 rule on another SG", (p) => (priorOf(p, `${H}.aws_vpc_security_group_ingress_rule.https_from_cloudfront`).values.security_group_id = "sg-0ffffffffffffffff")],
        ["the 443 rule from a CIDR", (p) => Object.assign(priorOf(p, `${H}.aws_vpc_security_group_ingress_rule.https_from_cloudfront`).values, { prefix_list_id: null, cidr_ipv4: "0.0.0.0/0" })],
        ["the 443 rule on another prefix list", (p) => (priorOf(p, `${H}.aws_vpc_security_group_ingress_rule.https_from_cloudfront`).values.prefix_list_id = "pl-0fffffff")],
        ["the egress rule on another SG", (p) => (priorOf(p, `${H}.aws_vpc_security_group_egress_rule.https["443"]`).values.security_group_id = "sg-0ffffffffffffffff")],
        ["the SG in another VPC", (p) => (priorOf(p, `${H}.aws_security_group.host`).values.vpc_id = "vpc-0fffffffffffffff0")],
        ["the SG named otherwise", (p) => (priorOf(p, `${H}.aws_security_group.host`).values.name = "gs-staging-other")],
        ["the EIP associated with another ENI", (p) => (priorOf(p, `${H}.aws_eip_association.host`).values.network_interface_id = "eni-0ffffffffffffffff")],
        ["the EIP associated with an instance", (p) => (priorOf(p, `${H}.aws_eip_association.host`).values.instance_id = "i-0ffffffffffffffff")],
        ["the instance on another ENI", (p) => (priorOf(p, `${H}.aws_instance.host`).values.primary_network_interface[0].network_interface_id = "eni-0ffffffffffffffff")],
        ["the instance without IMDSv2", (p) => (priorOf(p, `${H}.aws_instance.host`).values.metadata_options[0].http_tokens = "optional")],
        ["the instance with a key pair", (p) => (priorOf(p, `${H}.aws_instance.host`).values.key_name = "ops")],
        ["the instance unprotected", (p) => (priorOf(p, `${H}.aws_instance.host`).values.disable_api_termination = false)],
        ["the ENI in another subnet", (p) => (priorOf(p, `${H}.aws_network_interface.host`).values.subnet_id = "subnet-0fffffffffffffff1")],
        ["the status alarm on another instance", (p) => (priorOf(p, `${H}.aws_cloudwatch_metric_alarm.status_check`).values.dimensions = { InstanceId: "i-0ffffffffffffffff" })],
        ["the health alarm on another metric", (p) => (priorOf(p, `${H}.aws_cloudwatch_metric_alarm.health`).values.metric_name = "Other")],
        ["the budget above the ceiling", (p) => (priorOf(p, `${H}.aws_budgets_budget.monthly[0]`).values.limit_amount = "300.00")],
        ["the log group renamed", (p) => (priorOf(p, `${H}.aws_cloudwatch_log_group.host`).values.name = "/gs/staging/other")],
      ];
      for (const [what, mutate] of cases) {
        const p = make();
        mutate(p);
        rejects(p, topo, ctx);
        assert.ok(what);
      }
    });
    test(`${name}: the wrong host role, profile or policy`, () => {
      const cases: Array<[RegExp, (p: Obj) => void]> = [
        [/the role is named gs-staging-other-app/, (p) => (priorOf(p, `${H}.aws_iam_role.host`).values.name = "gs-staging-other-app")],
        [/the instance's profile is gs-staging-other-app/, (p) => (priorOf(p, `${H}.aws_instance.host`).values.iam_instance_profile = "gs-staging-other-app")],
        [/the instance profile gs-staging-host-app wraps gs-staging-other-app/, (p) => (priorOf(p, `${H}.aws_iam_instance_profile.host`).values.role = "gs-staging-other-app")],
        [/the inline policy is on gs-staging-other-app/, (p) => (priorOf(p, `${H}.aws_iam_role_policy.host`).values.role = "gs-staging-other-app")],
        [/managed policies on the role/, (p) => (priorOf(p, `${H}.aws_iam_role.host`).values.managed_policy_arns = ["arn:aws:iam::aws:policy/AdministratorAccess"])],
        [/the role carries another inline policy: extra/, (p) => priorOf(p, `${H}.aws_iam_role.host`).values.inline_policy.push({ name: "extra", policy: "{}" })],
        [/the role's trust/, (p) => (priorOf(p, `${H}.aws_iam_role.host`).values.assume_role_policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Ec2ThisAccountOnly", Effect: "Allow", Action: "sts:AssumeRole", Principal: { AWS: "*" } }] }))],
        [/the host policy: .*reaches table gs-staging-game-g2/, (p) => (priorOf(p, `${H}.aws_iam_role_policy.host`).values.policy = String(priorOf(p, `${H}.aws_iam_role_policy.host`).values.policy).replace(/gs-staging-game-g1/g, "gs-staging-game-g2"))],
      ];
      for (const [why, mutate] of cases) {
        const p = make();
        mutate(p);
        rejects(p, why, ctx);
      }
      /* the policy's facts come from the OPERATOR: a ledger / keys the operator did not name refuse the existing policy */
      rejects(make(), /the host policy's inputs do not match/, { ...ctx, ledgerTableArn: "arn:aws:dynamodb:us-east-1:333333333333:table/gs-staging-ledger" });
      rejects(make(), /the host policy's inputs do not match/, { ...ctx, signingKeyArns: undefined });
    });
  }
  for (const [name, make, ctx] of BOTH) {
    test(`${name} (review F1): AWS naming the attached instance on the EIP association is accepted -- only THIS instance`, () => {
      const p = make();
      priorOf(p, `${H}.aws_eip_association.host`).values.instance_id = priorOf(p, `${H}.aws_instance.host`).values.id;
      const r = judgeOf(GATE, p, ctx);
      assert.equal(r.verdict, "PASS", failures(r).join("\n"));
      const q = make();
      priorOf(q, `${H}.aws_eip_association.host`).values.instance_id = "i-0ffffffffffffffff";
      rejects(q, /the EIP association joins .*at most this instance/, ctx);
    });
    test(`${name} (review F2): a live rule outside Terraform on the host group (SSH opened by hand) is not the reviewed topology`, () => {
      const rule = (o: Obj): Obj => ({ cidr_blocks: [], ipv6_cidr_blocks: [], prefix_list_ids: [], security_groups: [], self: false, description: "", protocol: "tcp", ...o });
      const pl = priorOf(make(), `${H}.aws_vpc_security_group_ingress_rule.https_from_cloudfront`).values.prefix_list_id as string;
      const ok = make();
      Object.assign(priorOf(ok, `${H}.aws_security_group.host`).values, { ingress: [rule({ from_port: 443, to_port: 443, prefix_list_ids: [pl] })], egress: [rule({ from_port: 443, to_port: 443, cidr_blocks: ["0.0.0.0/0"] })] });
      const r = judgeOf(GATE, ok, ctx);
      assert.equal(r.verdict, "PASS", failures(r).join("\n"));
      for (const extra of [rule({ from_port: 22, to_port: 22, cidr_blocks: ["0.0.0.0/0"] }), rule({ from_port: 80, to_port: 80, cidr_blocks: ["0.0.0.0/0"] }), rule({ from_port: 443, to_port: 443, cidr_blocks: ["0.0.0.0/0"] }), rule({ protocol: "-1", from_port: 0, to_port: 0, cidr_blocks: ["10.0.0.0/8"] })]) {
        const p = clone(ok);
        priorOf(p, `${H}.aws_security_group.host`).values.ingress.push(extra);
        rejects(p, /the security group admits more than the reviewed 443-from-CloudFront rule/, ctx);
      }
      const eg = clone(ok);
      priorOf(eg, `${H}.aws_security_group.host`).values.egress.push(rule({ protocol: "-1", from_port: 0, to_port: 0, cidr_blocks: ["0.0.0.0/0"] }));
      rejects(eg, /egress is more than the reviewed rules/, ctx);
    });
    test(`${name} (review F3/F4): a prior state Terraform never writes -- a repeated address, a misfiled entry, a foreign mode or data source`, () => {
      const dup = make();
      const host = priorOf(dup, `${H}.aws_instance.host`);
      const mod = priorList(dup).find((m) => (m.resources as Obj[]).includes(host))!;
      (mod.resources as Obj[]).unshift({ ...clone(host), values: { ...clone(host.values), id: "i-0ffffffffffffffff" } });
      rejects(dup, /the prior state is not one Terraform wrote: module\.host\.aws_instance\.host twice/, ctx);
      const root = make();
      root.prior_state.values.root_module.resources = [clone(priorOf(root, `${H}.aws_instance.host`))];
      rejects(root, /not one Terraform wrote: module\.host\.aws_instance\.host: not its module/, ctx);
      const mode = make();
      addPrior(mode, { address: `${H}.aws_instance.second`, mode: "Managed", type: "aws_instance", name: "second", provider_name: "registry.terraform.io/hashicorp/aws", values: {} });
      rejects(mode, /mode Managed/, ctx);
      /* host-create: the full create over a state carrying only such an entry */
      const full = clone(PLANS["host-create"]) as Obj;
      full.prior_state = { format_version: "1.0", values: { root_module: { child_modules: [{ address: H, resources: [{ address: `${H}.aws_instance.second`, mode: "Managed", type: "aws_instance", name: "second", provider_name: "registry.terraform.io/hashicorp/aws", values: {} }] }] } } };
      rejects(full, /the prior state holds no host resource yet: .*mode Managed/, CTX, "host-create");
      const data = make();
      addPrior(data, { address: `${H}.data.aws_instance.x`, mode: "data", type: "aws_instance", name: "x", provider_name: "registry.terraform.io/hashicorp/aws", values: {} });
      rejects(data, /data source aws_instance/, ctx);
    });
  }
  test("synthetic: the role's policy in the state is exactly the module's rendering (hostPolicy)", () => {
    assert.equal(priorOf(synthetic(), `${H}.aws_iam_role_policy.host`).values.policy, hostPolicy());
  });
});

describe("STEP 9 ACME HOTFIX: nothing that exists may change", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: an update, a replacement, a delete, a forget of an existing object`, () => {
      const up = make();
      setAction(up, `${H}.aws_instance.host`, ["update"], { ...rc(up, `${H}.aws_instance.host`).change.after, instance_type: "t4g.medium" });
      rejects(up, /module\.host\.aws_instance\.host \[update\]/, ctx);
      rejects(up, /exactly one change: CREATE/, ctx);
      const rep = make();
      setAction(rep, `${H}.aws_instance.host`, ["delete", "create"]);
      rejects(rep, /every existing step-9 object is in the plan, a no-op.*aws_instance\.host \[delete,create\]/, ctx);
      const rep2 = make();
      setAction(rep2, `${H}.aws_security_group.host`, ["create", "delete"]);
      rejects(rep2, /aws_security_group\.host \[create,delete\]/, ctx);
      const del = make();
      setAction(del, `${H}.aws_eip.host`, ["delete"], null);
      rejects(del, /aws_eip\.host \[delete\]/, ctx);
      const pol = make();
      setAction(pol, `${H}.aws_iam_role_policy.host`, ["update"]);
      rejects(pol, /aws_iam_role_policy\.host \[update\]/, ctx);
      const forget = make();
      setAction(forget, `${H}.aws_cloudwatch_metric_alarm.health`, ["forget"], null);
      rejects(forget, /aws_cloudwatch_metric_alarm\.health \[forget\]/, ctx);
      const gone = make();
      gone.resource_changes = rcs(gone).filter((c) => c.address !== `${H}.aws_budgets_budget.monthly[0]`);
      rejects(gone, /aws_budgets_budget\.monthly\[0\] \[not in the plan\]/, ctx);
    });
    test(`${name}: a TARGETED plan (only the rule and its group) shows no proof the rest is untouched`, () => {
      const p = make();
      p.resource_changes = rcs(p).filter((c) => c.address === ACME || c.address === `${H}.aws_security_group.host`);
      rejects(p, /not in the plan/, ctx);
    });
  }
});

describe("STEP 9 ACME HOTFIX: the one create is exactly the reviewed ACME rule", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: port 22, a port other than exactly 80, another protocol`, () => {
      for (const [from, to] of [[22, 22], [81, 81], [80, 81], [79, 80], [0, 65535], [443, 443], [8917, 8917]]) {
        const p = make();
        Object.assign(acmeAfter(p), { from_port: from, to_port: to });
        rejects(p, /exactly tcp 80-80/, ctx);
        if (from <= 22 && to >= 22) rejects(p, /emergency SSH stays absent/, ctx);
      }
      for (const proto of ["udp", "-1", "all", "6", "TCP"]) {
        const p = make();
        acmeAfter(p).ip_protocol = proto;
        rejects(p, /exactly tcp 80-80/, ctx);
      }
    });
    test(`${name}: a source narrower, wider or other than 0.0.0.0/0`, () => {
      const cases: Obj[] = [{ cidr_ipv4: "10.0.0.0/8" }, { cidr_ipv4: "203.0.113.7/32" }, { cidr_ipv4: "0.0.0.0/1" }, { cidr_ipv4: null, cidr_ipv6: "::/0" }, { cidr_ipv6: "::/0" }, { cidr_ipv4: null, prefix_list_id: "pl-3b927c52" }, { prefix_list_id: "pl-3b927c52" }, { cidr_ipv4: null, referenced_security_group_id: "sg-0ffffffffffffffff" }, { cidr_ipv4: "0.0.0.0/00" }];
      for (const patch of cases) {
        const p = make();
        Object.assign(acmeAfter(p), patch);
        rejects(p, /exactly 0\.0\.0\.0\/0/, ctx);
      }
    });
    test(`${name}: the wrong security group (another, or unknown until apply)`, () => {
      const p = make();
      acmeAfter(p).security_group_id = "sg-0ffffffffffffffff";
      rejects(p, /not the existing host group/, ctx);
      const u = make();
      acmeAfter(u).security_group_id = null;
      rc(u, ACME).change.after_unknown.security_group_id = true;
      rejects(u, /\(unknown until apply\), not the existing host group/, ctx);
    });
    test(`${name}: the apostrophe (or any description EC2 refuses) never passes again`, () => {
      for (const d of ["Let's Encrypt HTTP-01 only (Caddy serves the challenge and 404; never proxies on 80)", "x".repeat(256), "naïve", 7]) {
        const p = make();
        acmeAfter(p).description = d;
        rejects(p, /is not one EC2 accepts/, ctx);
      }
      const u = make();
      rc(u, ACME).change.after_unknown.description = true;
      rejects(u, /description \(unknown until apply\)/, ctx);
    });
    test(`${name}: something else unknown, another region, the rule not a create`, () => {
      const p = make();
      rc(p, ACME).change.after_unknown.cidr_ipv4 = true;
      rejects(p, /unknown until apply \(cannot be judged\): cidr_ipv4|exactly 0\.0\.0\.0\/0/, ctx);
      const r = make();
      acmeAfter(r).region = "eu-west-1";
      rejects(r, /in region eu-west-1/, ctx);
      const missing = make();
      missing.resource_changes = rcs(missing).filter((c) => c.address !== ACME);
      rejects(missing, /exactly one change: CREATE/, ctx);
    });
  }
});

describe("STEP 9 ACME HOTFIX: no extra create, no second host, nothing foreign", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: an extra create beside the rule`, () => {
      const extras: Obj[] = [
        resourceChange({ module: H, type: "aws_cloudwatch_metric_alarm", name: "extra", actions: ["create"], before: null, after: { alarm_name: "x" } }),
        resourceChange({ module: H, type: "aws_vpc_security_group_egress_rule", name: "https", index: "8443", actions: ["create"], before: null, after: { ip_protocol: "tcp", from_port: 8443, to_port: 8443, cidr_ipv4: "0.0.0.0/0" } }),
        resourceChange({ module: H, type: "aws_vpc_security_group_ingress_rule", name: "acme_http01_v6", actions: ["create"], before: null, after: { ip_protocol: "tcp", from_port: 80, to_port: 80, cidr_ipv6: "::/0" } }),
      ];
      for (const extra of extras) {
        const p = make();
        rcs(p).push(extra);
        rejects(p, /NOT PART OF THIS STEP/, ctx);
        rejects(p, /exactly one change: CREATE/, ctx);
      }
    });
    test(`${name}: a second instance, a second EIP, a second ENI / SG / role / profile / budget / log group / alarm set`, () => {
      const types: Array<[string, RegExp]> = [
        ["aws_instance", /2 instance \(1\)/],
        ["aws_eip", /2 Elastic IP \(1\)/],
        ["aws_network_interface", /2 ENI \(1\)/],
        ["aws_security_group", /2 security group \(1\)/],
        ["aws_iam_role", /2 IAM role \(1\)/],
        ["aws_iam_instance_profile", /2 instance profile \(1\)/],
        ["aws_budgets_budget", /2 budget \(1\)/],
        ["aws_cloudwatch_log_group", /2 log group \(1\)/],
        ["aws_cloudwatch_metric_alarm", /6 alarms \(5\)/],
      ];
      for (const [type, why] of types) {
        const p = make();
        rcs(p).push(resourceChange({ module: H, type, name: "second", actions: ["create"], before: null, after: { domain: "vpc" } }));
        rejects(p, why, ctx);
        rejects(p, /NOT PART OF THIS STEP/, ctx);
      }
    });
    test(`${name}: emergency SSH, the ECR lifecycle (created, or as variables)`, () => {
      const ssh = make();
      rcs(ssh).push(resourceChange({ module: H, type: "aws_vpc_security_group_ingress_rule", name: "emergency_ssh", index: "203.0.113.7/32", actions: ["create"], before: null, after: { ip_protocol: "tcp", from_port: 22, to_port: 22, cidr_ipv4: "203.0.113.7/32", security_group_id: sgOf(ssh) } }));
      rejects(ssh, /emergency SSH stays absent/, ctx);
      const sshVar = make();
      variable(sshVar, "emergency_ssh_cidrs", ["203.0.113.7/32"]);
      rejects(sshVar, /emergency_ssh_cidrs = \["203\.0\.113\.7\/32"\] \(exactly \[\]\)/, ctx);
      const ecr = make();
      rcs(ecr).push(resourceChange({ module: H, type: "aws_ecr_lifecycle_policy", name: "server", index: 0, actions: ["create"], before: null, after: { repository: "gs-staging-server", policy: "{}" } }));
      rejects(ecr, /no ECR lifecycle \(step 22b\)/, ctx);
      const ecrVar = make();
      variable(ecrVar, "manage_ecr_lifecycle", true);
      rejects(ecrVar, /manage_ecr_lifecycle = true/, ctx);
    });
    test(`${name}: an ALB, ECS, NAT, endpoint, CloudFront, DynamoDB, KMS, SSM or other foreign resource`, () => {
      for (const type of ["aws_lb", "aws_ecs_service", "aws_nat_gateway", "aws_vpc_endpoint", "aws_cloudfront_distribution", "aws_dynamodb_table", "aws_kms_key", "aws_ssm_parameter", "aws_backup_vault", "aws_route53_record", "aws_s3_bucket"]) {
        const p = make();
        rcs(p).push(resourceChange({ module: H, type, name: "x", actions: ["create"], before: null, after: {} }));
        rejects(p, /NOT PART OF THIS STEP/, ctx);
        if (!["aws_route53_record", "aws_s3_bucket"].includes(type)) rejects(p, /no authority, ECS-era or foreign resource/, ctx);
      }
      const app = make();
      rcs(app).push(resourceChange({ module: "module.app", type: "aws_lb", name: "this", index: 0, actions: ["create"], before: null, after: {} }));
      rejects(app, /entries outside this stack's module/, ctx);
    });
  }
});

describe("STEP 9 ACME HOTFIX: data sources, generations, the envelope", () => {
  for (const [name, make, ctx] of BOTH) {
    test(`${name}: a data source deferred to apply; a deferred change`, () => {
      const p = make();
      rcs(p).push(resourceChange({ module: H, mode: "data", type: "aws_ec2_managed_prefix_list", name: "cloudfront_origin_facing", actions: ["read"], before: null, after: {}, reason: "read_because_dependency_pending" }));
      rejects(p, /every data source read at plan time/, ctx);
      const d = make();
      d.deferred_changes = [{ reason: "provider_config_unknown", resource_change: rcs(d)[0] }];
      rejects(d, /nothing deferred/, ctx);
    });
    test(`${name}: generation != 1; game_generations not exactly [1]`, () => {
      const g = make();
      variable(g, "generation", 2);
      rejects(g, /generation = 2 \(exactly 1\)/, ctx);
      for (const gens of [[1, 2], [2], [], "[1]x"]) {
        const p = make();
        variable(p, "game_generations", gens);
        rejects(p, /game_generations = .*\(exactly \[1\]\)/, ctx);
      }
      const g2 = make();
      variable(g2, "game_generations", [1, 2]);
      rejects(g2, /g1 serves; every other generation stays inert/, ctx);
    });
    test(`${name}: another pool; the budget off; a provisioner; a foreign module source`, () => {
      const pool = make();
      variable(pool, "pool", "p2");
      rejects(pool, /pool = "p2"/, ctx);
      const b = make();
      variable(b, "budget", { enabled: false });
      rejects(b, /budget\.enabled is not true/, ctx);
      const prov = make();
      (Object.values(prov.configuration.root_module.module_calls)[0] as Obj).module.resources[0].provisioners = [{ type: "local-exec" }];
      rejects(prov, /provisioner/, ctx);
      const src = make();
      (Object.values(src.configuration.root_module.module_calls)[0] as Obj).source = "git::https://example.org/x.git//modules/single-host";
      rejects(src, /from git::https/, ctx);
    });
  }
});

describe("STEP 9 ACME HOTFIX: the command -- a clean committed checkout, the saved plan bound", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "step9-"));
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const COMMIT = "7d140b4db777faccf11e220bcf7e3bcbd8fc889a";
  function evidence(opts: { dirty?: boolean; noCommit?: boolean; tamper?: boolean; keep?: boolean; stack?: string; plan?: unknown } = {}): string {
    const dir = tmp();
    const planText = JSON.stringify(opts.plan ?? PLANS[GATE]);
    fs.writeFileSync(path.join(dir, "plan.json"), planText);
    fs.writeFileSync(path.join(dir, "plan-exitcode.txt"), "2\n");
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ terraform_version: "1.16.5", provider_selections: { "registry.terraform.io/hashicorp/aws": "6.66.0" } }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ format: "18COSMOS/L6-6-PLAN/v1", run_id: "step9-test", stack: opts.stack ?? GATES[GATE].stack, captured_at: "2026-10-03T08:00:00Z", ...(opts.noCommit === true ? {} : { commit: COMMIT, infra_aws_clean: opts.dirty !== true }), targets: [] }));
    if (opts.keep !== false) {
      const binary = Buffer.from("binary completion plan");
      fs.writeFileSync(path.join(dir, SAVED_PLAN), binary);
      fs.writeFileSync(path.join(dir, SAVED_PLAN_SHA), `${sha(binary)}  ${SAVED_PLAN}\n${sha(Buffer.from(planText))}  plan.json\n`);
      if (opts.tamper === true) fs.writeFileSync(path.join(dir, SAVED_PLAN), Buffer.from("another plan"));
    }
    return dir;
  }
  const run = async (argv: string[]) => {
    const lines: string[] = [];
    const code = await migrationGuardCommand(argv, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  const args = (dir: string, extra: string[] = ["--commit", COMMIT]) => [GATE, "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId, "--region", FIXTURE.region, "--ledger-table-arn", FIXTURE.ledgerTableArn, "--signing-keys", FIXTURE.signingKeyArns.join(","), ...extra];

  test("PASS (exit 0): apply ONLY that saved plan; the record binds it", async () => {
    const dir = evidence();
    const record = path.join(dir, "guard.json");
    const r = await run(args(dir, ["--commit", COMMIT, "--record", record]));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /COST-2B MIGRATION GUARD host-create-complete: PASS \(apply ONLY this saved plan.*stacks\/single-host apply/);
    assert.match(r.text, /step D 9 \(recovery: complete an interrupted step 9\)/);
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(rec.gate, GATE);
    assert.equal(rec.saved_plan_sha256, sha(Buffer.from("binary completion plan")));
    assert.deepEqual(rec.changes, [`${ACME} [create]`]);
  });
  test("a dirty or uncommitted checkout, a mismatched or missing saved plan, the wrong commit or stack: FAIL (exit 1)", async () => {
    const C = ["--commit", COMMIT];
    const cases: Array<[Parameters<typeof evidence>[0], RegExp, string[]]> = [
      [{ dirty: true }, /infra\/aws was not clean/, C],
      [{ noCommit: true }, /run\.json names no commit/, C],
      [{ tamper: true }, /does not bind stack\.tfplan and plan\.json/, C],
      [{ keep: false }, /capture with plan-evidence --keep-plan/, C],
      [{}, /not --commit 0000/, ["--commit", "0".repeat(40)]],
      [{ stack: "app" }, /run\.json names app; host-create-complete judges stacks\/single-host/, C],
      [{ plan: PLANS["host-create"] }, /prior state: exactly the interrupted step 9/, C],
    ];
    for (const [opts, why, extra] of cases) {
      const r = await run(args(evidence(opts), extra));
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, why);
      assert.match(r.text, /DO NOT APPLY/);
    }
  });
  test("usage: the operator's ledger / keys / region are required (exit 2)", async () => {
    const dir = evidence();
    const r = await run([GATE, "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId]);
    assert.equal(r.code, 2);
    assert.match(r.text, /host-create-complete needs --region .*--ledger-table-arn .*--signing-keys/);
    const noCommit = await run(args(dir, []));
    assert.equal(noCommit.code, 2);
    assert.match(noCommit.text, /host-create-complete needs --commit <the reviewed hotfix commit>/);
  });
});

describe("STEP 9 ACME HOTFIX: the reproduction and the runbook", () => {
  test("the Terraform reproduction is committed beside its fixture", () => {
    for (const f of ["reproduce.sh", "fake_cw_budgets.py", "moto_gaps.py", "provider_override.tf.example", "staging.tfvars.example"]) assert.ok(fs.existsSync(path.join(REPO, FIXTURE_DIR, "terraform-real/reproduce-step9", f)), f);
    assert.match(read(`${FIXTURE_DIR}/terraform-real/README.md`), /host-create-complete\.json/);
  });
  test("the runbook names the recovery path and keeps host-create the normal one", () => {
    const RUNBOOK = read("infra/aws/SINGLE_HOST_MIGRATION.md");
    assert.match(RUNBOOK, /migration-guard host-create-complete/);
    assert.match(RUNBOOK, /migration-guard host-create --region/);
    assert.match(RUNBOOK, /acme_http01/);
    assert.match(RUNBOOK, /ordinary single-host apply.*(forbidden|never)/i);
  });
});
