// server/src/aws/deploy/migration/phase1RemainderRunbook.test.ts
//
// PHASE 1 REMAINDER: the confirmed procedural corrections to infra/aws/SINGLE_HOST_MIGRATION.md, pinned (static; no AWS):
//   F0     the Terraform directory resolves from the documented working context (the repository root);
//   F3     set-operator-plan carries the required --to-relayer;
//   F5/F6  the host-role probes are the documented path (gs-host role-probe, judged by stage-probe host-role);
//   drills the FINAL redeploy with -Measure after F7 / F8 / F9 (and step 21 keeps -Measure);
//   14-16  `aws cloudfront wait distribution-deployed` after the step-14 apply, before 15b and 16; step 16 is the
//          single-host edge probe on 15b's evidence;
//   19     retire-check WITH --evidence (R6), RETIRED required;
//   20-pre the ALB's LIVE deletion protection read before step 20; true is a STOP; no unprotect step is invented;
//   22c    the Container Insights log groups: owner GO, outside Terraform, after step 20, before step 24;
//   closure step 24 = operational closure, step 25 trailing confirmation, the $30/month ceiling unchanged;
//   and nothing in modules/ or stacks/ moved (no Terraform resource shape changed).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
const BOOK = read("infra/aws/SINGLE_HOST_MIGRATION.md");
const BASE = "083d0668556c05a84eb8b3e5befc4e973544aa9a";

/** The runbook text from a numbered step's start to the next numbered step (e.g. "19." up to "20-pre."). */
const at = (marker: string): number => {
  const i = BOOK.search(new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.ok(i >= 0, `the runbook has ${marker}`);
  return i;
};
const between = (from: string, to: string) => BOOK.slice(at(from), at(to));

describe("PHASE 1 REMAINDER: the migration runbook's corrections", () => {
  test("F0: --terraform-dir resolves from the repository root (the documented working context), never the bare stacks/ path", () => {
    assert.match(BOOK, /capture-host-evidence\.sh staging <region> <i-\.\.\.> <distribution id> ev-F --terraform-dir infra\/aws\/stacks\/single-host/);
    assert.match(BOOK, /every line below runs from the \*\*repository root\*\*/);
    for (const text of [BOOK, read("infra/aws/README.md"), read("server/src/aws/deploy/hostVerify.ts")]) assert.doesNotMatch(text, /--terraform-dir stacks\/single-host/);
    assert.ok(fs.existsSync(path.join(REPO, "infra/aws/stacks/single-host/main.tf")), "the documented directory is the single-host stack");
    assert.ok(!fs.existsSync(path.join(REPO, "stacks/single-host")), "the former path does not exist from the root");
    /* A failing `terraform output` is NOT EVALUATED (a STOP): the runbook says to check it first, or omit the flag. */
    assert.match(BOOK, /OMIT\s+`--terraform-dir` \(that one check is then an explicit SKIP, which does not block VERIFIED\)/);
  });

  test("F3: set-operator-plan carries the required --to-relayer (the active relayer) and must say READY", () => {
    const f3 = BOOK.split("\n").find((l) => l.startsWith("| F3 |")) ?? "";
    assert.match(f3, /set-operator-plan --runtime-parameter <runtime p1 ARN> --environment staging --to-relayer <the ACTIVE relayer/);
    assert.match(f3, /ALREADY <that address>/);
    assert.match(f3, /READY: set-operator-plan --to-relayer/);
    for (const line of BOOK.split("\n").filter((l) => /set-operator-plan --/.test(l))) assert.match(line, /--to-relayer /, line);
  });

  test("F5 / F6: the host-role probes on the real host, under the instance role, from the serving release", () => {
    const rows = BOOK.split("\n").filter((l) => /^\| F[56] \|/.test(l)).join("\n");
    assert.match(rows, /gs-host role-probe .*-Probe kms/);
    assert.match(rows, /stage-probe host-role --probe kms/);
    assert.match(rows, /-Probe transactions/);
    assert.doesNotMatch(rows, /docker run --rm/, "no hand-made docker run (it would start a second writer)");
    assert.match(BOOK, /gs-host\.ps1 -Command role-probe -InstanceId <i-\.\.\.> -Region <r> -Digest <the serving sha256> -RunId <run-f5> -Probe kms -Generation 1 -Pool p1/);
    assert.match(BOOK, /HOST-ROLE PROBE F5 KMS: PASS/);
    assert.match(BOOK, /HOST-ROLE PROBE F6 DYNAMODB: PASS/);
  });

  test("after F7 / F8 / F9: the FINAL redeploy with -Measure is required (drill redeploys write GS_MEASURE=0); step 21 keeps it", () => {
    const section = BOOK.slice(BOOK.indexOf("**After the drills: the FINAL redeploy with `-Measure`"), BOOK.indexOf("**Known limitations kept fail-closed"));
    assert.ok(section.length > 0);
    assert.match(section, /GS_MEASURE=0/);
    assert.match(section, /gs-host\.ps1 -Command deploy -InstanceId <i-\.\.\.> -Region <r> -Digest <the serving sha256> -BuildId <its build> -Measure/);
    assert.match(section, /required, not optional/);
    assert.ok(BOOK.indexOf("**After the drills: the FINAL redeploy") < at("14."), "before the cutover");
    assert.match(between("21.", "22."), /AND `-Measure`/);
  });

  test("step 15: `aws cloudfront wait distribution-deployed` after the step-14 apply, before 15b and 16", () => {
    const wait = BOOK.indexOf("aws cloudfront wait distribution-deployed --id <distribution id>");
    assert.ok(wait > at("14.") && wait < at("15b.") && wait < at("16."), "between 14 and 15b / 16");
    assert.match(between("15.", "15b."), /never start 15b or 16\s+on a timeout/);
  });

  test("step 16: the single-host edge probe on 15b's evidence (never the ECS prerequisite or the ALB)", () => {
    const s16 = between("16.", "17.");
    assert.match(s16, /stage-probe edge --topology single-host/);
    assert.match(s16, /--host-evidence <ev-15b> --instance-id <i-\.\.\.> --origin-hostname <origin_hostname>/);
    assert.match(s16, /SINGLE-HOST EDGE PROBE: PASS/);
    const command = s16.split("\n").filter((l) => /stage-probe edge --topology single-host --run-id/.test(l));
    assert.equal(command.length, 1, "one command line");
    assert.doesNotMatch(s16, / \\$/m, "no bash line continuation (the step runs in PowerShell too)");
    assert.match(between("15b.", "16."), /--record <ev-15b>\/verify\.json --report <ev-15b>/);
  });

  test("step 19: retire-check WITH --evidence, so R6 is judged; RETIRED is required (READY-TO-DRAIN exits 0 but is a STOP)", () => {
    const s19 = between("19.", "20-pre.");
    assert.match(s19, /capture-evidence\.sh staging <region> p1 <distribution id> <D>\/retire-p2 p2/);
    assert.match(s19, /aws retire-check p2 --evidence <D>\/retire-p2 --aws-config <runtime p1 ARN>/);
    assert.match(s19, /retire-check p2 \(READ-ONLY\) -- RETIRED/);
    assert.match(s19, /`READY-TO-DRAIN` or `BLOCKED` is a STOP/);
    for (const line of BOOK.split("\n").filter((l) => /retire-check p2(?! \(READ-ONLY\))/.test(l))) assert.match(line, /--evidence/, line);
  });

  test("20-pre: the ALB's LIVE deletion protection is read before step 20; true STOPS; no unprotect step is invented", () => {
    const pre = between("20-pre.", "20.");
    assert.match(pre, /describe-load-balancer-attributes --load-balancer-arn <that ARN> --query "Attributes\[\?Key=='deletion_protection\.enabled'\]\.Value"/);
    assert.match(pre, /`false`: proceed to step 20/);
    assert.match(pre, /`true`: \*\*STOP before the compute-none capture and apply\.\*\*/);
    assert.match(pre, /SEPARATELY reviewed, owner-authorized/);
    assert.doesNotMatch(BOOK, /modify-load-balancer-attributes/, "the unprotect step is not written until live staging needs it");
    assert.ok(at("20-pre.") < at("20."));
  });

  test("22c: the Container Insights log groups -- owner GO, outside Terraform, after step 20's apply, before step 24", () => {
    const ci = between("22c.", "23.");
    assert.match(ci, /OWNER GO/);
    assert.match(ci, /\/aws\/ecs\/containerinsights\/gs-staging\//);
    assert.match(ci, /Terraform never created them and holds none of them in any state/);
    assert.match(ci, /Only with the owner's explicit GO naming each listed group: `aws logs delete-log-group --log-group-name <name>`/);
    assert.match(ci, /never a wildcard/);
    assert.match(ci, /never before step\s+20's apply/);
    assert.ok(at("22b.") < at("22c.") && at("22c.") < at("24."));
    assert.match(between("24.", "25."), /step 22c is done/);
  });

  test("Phase-1 closure: step 24 closes operationally, step 25 trails, the $30/month ceiling is unchanged and later evidence reopens it", () => {
    const closure = BOOK.slice(BOOK.indexOf("**Phase-1 closure (the owner's roadmap"));
    assert.match(closure, /\*\*\$30\/month\*\* steady state/);
    assert.match(closure, /Operational Phase-1 migration closure = step 24/);
    assert.match(closure, /do NOT\s+hold Phase 2 \(testnet\) work back/);
    assert.match(closure, /above the \$30\/month ceiling reopens the cost issue/);
    assert.match(between("25.", "## COST-2C"), /Cost Explorer daily for 5–7 days/, "step 25's billing observation is kept");
    assert.match(read("infra/aws/COST_BUDGET.json"), /"hard_maximum_monthly"\s*:\s*30\b/);
  });

  test("the known fail-closed limitations are recorded, not redesigned", () => {
    const known = BOOK.slice(BOOK.indexOf("**Known limitations kept fail-closed"), BOOK.indexOf("Any failure: STOP. **Rollback before G**"));
    for (const item of [/interrupted drill/i, /Step 13's READY/, /-TeardownAppliedAt/, /F10 \(replacement\)/, /Alarm notifications/]) assert.match(known, item);
  });

  test("no Terraform module or stack changed since the certified base (the host's resource shape is untouched)", () => {
    const r = spawnSync("git", ["-C", REPO, "diff", "--name-only", BASE, "--", "infra/aws/modules", "infra/aws/stacks"], { encoding: "utf8" });
    if (r.status !== 0) return; // not a checkout holding the base commit: the owner gate's clean-clone diff covers it
    /* PHASE 1 FRESH-HOST HARDENING changed three HOST SCRIPTS (and the module's bash tests and README) -- no .tf,
       template, unit or stack. The scripts are embedded in the instance's user data, so a stacks/single-host plan from that commit REPLACES
       the instance: the live host takes them by the reviewed one-file install (runbook 13r), and step 22b is planned from
       the host-create commit's module (the runbook says so). */
    const freshHost = new Set(["files/bin/gs-preflight", "files/bin/gs-lib.sh", "files/bin/gs-health", "tests/host-scripts.test.sh", "tests/preflight-real-docker.test.sh", "README.md"].map((f) => `infra/aws/modules/single-host/${f}`));
    /* PHASE 1 CLEAN-BUILD RESET removed exactly two ROOT variables' defaults (stacks/app `compute`, stacks/ledger
       `ecs_task_role_authorized`) and stated them in the examples -- no resource, module, template or single-host change;
       migration/phase1CleanBuild pins that each variables.tf differs from its base by that one default only. */
    const cleanBuild = new Set(["infra/aws/stacks/app/variables.tf", "infra/aws/stacks/app/example.tfvars.example", "infra/aws/stacks/ledger/variables.tf", "infra/aws/stacks/ledger/example.tfvars.example"]);
    /* PHASE 1 T1 PROVIDER-6.66 pinned `response_completion_timeout = 0` on edge.tf's gs-alb origin (one line; the API
       request is unchanged) -- migration/phase1CleanBuild's "since the Phase-1 base, only those two root variables, ..."
       test pins that edge.tf differs from its base by that line only; this allowlist is narrow only while that pin stands. */
    const t1Provider666 = new Set(["infra/aws/modules/app/edge.tf"]);
    assert.deepEqual(r.stdout.trim().split("\n").filter((f) => f !== "" && !freshHost.has(f) && !cleanBuild.has(f) && !t1Provider666.has(f)), [], r.stdout);
  });
});
