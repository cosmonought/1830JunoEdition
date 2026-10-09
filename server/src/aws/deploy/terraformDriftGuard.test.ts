// server/src/aws/deploy/terraformDriftGuard.test.ts
//
// PHASE 3 ESCROW 2.1 RELEASE READINESS (owner ruling 2026-10-08, OPTION 1): the certified-Terraform drift guard ITSELF.
// The base stays 083d066; CONDUCT_REVIEWERS_WIRING is unchanged; the Escrow 2.1 delta is a pinned patch, required and
// exact; unrelated drift, a line beside a pinned change, a removed / altered / moved pinned line, future checksum / IAM /
// alarm / KMS drift, a tampered patch, and a missing base all FAIL -- nothing skips. Every mutation here is an in-memory
// overlay: the working tree is never written.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { CONDUCT_REVIEWERS_WIRING } from "./conductReviewersWiring";
import { ESCROW21_TERRAFORM_FILES, ESCROW21_TERRAFORM_LINE_COUNTS, ESCROW21_TERRAFORM_PATCH, ESCROW21_TERRAFORM_PATCH_SHA256, normalizeLf, parsePinnedPatch, reverseApplyPinnedHunks, sha256Hex } from "./escrow21TerraformWiring";
import { CERTIFIED_TERRAFORM_BASE, terraformDriftProblems } from "./terraformDriftGuard";
import { LUDUM_TERRAFORM_FILES, LUDUM_TERRAFORM_LINE_COUNTS, LUDUM_TERRAFORM_PATCH, LUDUM_TERRAFORM_PATCH_SHA256 } from "./ludumOriginsTerraformWiring";
import { terraformDriftIo } from "../../testSupport/terraformDriftIo";

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/aws/deploy -> the repository
const PATCH = fs.readFileSync(path.join(REPO, ESCROW21_TERRAFORM_PATCH), "utf8");
const LUDUM = fs.readFileSync(path.join(REPO, LUDUM_TERRAFORM_PATCH), "utf8");
const io = terraformDriftIo(REPO);
const ALL = ["infra/aws/modules", "infra/aws/stacks"];
const read = (rel: string) => normalizeLf(fs.readFileSync(path.join(REPO, rel), "utf8"));
/** LUDUM ORIGINS (the third exception, applied after Escrow 2.1): a file's text as the Escrow 2.1 delta left it -- the
 *  Ludum hunks reversed exactly, as the guard itself does first. Files the Ludum patch does not name are read as-is. */
const LUDUM_PARSED = parsePinnedPatch(LUDUM);
const escrowText = (rel: string): string => {
  const hunks = LUDUM_PARSED.ok ? LUDUM_PARSED.files.get(rel) : undefined;
  if (hunks === undefined) return read(rel);
  const r = reverseApplyPinnedHunks(read(rel), hunks, LUDUM_TERRAFORM_LINE_COUNTS.get(rel));
  assert.ok(r.ok, `${rel}: the Ludum hunks reverse exactly`);
  return r.text;
};
/** A mutation in a file both pins name is caught by whichever pin comes off first (Ludum): either names the file. */
const PINNED_CHANGE = /pinned (Escrow 2\.1|Ludum-origins) change/;

const check = (overlay?: ReadonlyMap<string, string | null>, scope: readonly string[] = ALL, extra: { base?: string; patchText?: string; ludumPatchText?: string } = {}) =>
  terraformDriftProblems(io, { scope, patchText: extra.patchText ?? PATCH, ludumPatchText: extra.ludumPatchText ?? LUDUM, overlay, base: extra.base });

/** An overlay changing one file; `edit` must change it (a mutation that matched nothing would prove nothing). */
const mutate = (file: string, edit: (text: string) => string): Map<string, string | null> => {
  const before = read(file);
  const after = edit(before);
  assert.notEqual(after, before, `the mutation of ${file} changed nothing`);
  return new Map([[file, after]]);
};
/** Replace the first `find` after the first `anchor`. */
const after = (anchor: string, find: string, replace: string) => (text: string) => {
  const a = text.indexOf(anchor);
  assert.ok(a >= 0, `anchor ${anchor}`);
  const f = text.indexOf(find, a);
  assert.ok(f >= 0, `${find} after ${anchor}`);
  return text.slice(0, f) + replace + text.slice(f + find.length);
};
const failsNaming = (problems: string[], file: string, pattern?: RegExp) => {
  assert.ok(problems.length > 0, `a change to ${file} must fail`);
  assert.ok(problems.some((p) => p.includes(file) && (pattern === undefined || pattern.test(p))), JSON.stringify(problems));
};

describe("certified Terraform drift guard: the base, the two reviewed exceptions, fail closed", () => {
  test("1. 083d066 stays the certified base, and both guards use it with no override and no early return", () => {
    assert.equal(CERTIFIED_TERRAFORM_BASE, "083d0668556c05a84eb8b3e5befc4e973544aa9a");
    for (const guard of ["server/src/aws/deploy/staging/hostRoleProbe.test.ts", "server/src/aws/deploy/migration/phase1RemainderRunbook.test.ts"]) {
      const src = read(guard);
      const calls = src.match(/terraformDriftProblems\(terraformDriftIo\(REPO\), \{[^}]*\}\)/g) ?? [];
      assert.equal(calls.length, 1, `${guard}: exactly one drift comparison`);
      assert.doesNotMatch(calls[0] ?? "", /\bbase\b|overlay/, `${guard}: never another base, never an overlay`);
      assert.match(src, /assert\.deepEqual\(problems, \[\]\);/);
      assert.doesNotMatch(src, /if \(r\.status !== 0\) return/, `${guard}: no silent skip`);
      assert.doesNotMatch(src, /spawnSync\("git"/, `${guard}: no private diff of its own`);
    }
  });

  test("the real tree passes: every module and stack, and modules/single-host alone", () => {
    assert.deepEqual(check(), []);
    assert.deepEqual(check(undefined, ["infra/aws/modules/single-host"]), []);
  });

  test("2. CONDUCT_REVIEWERS_WIRING is byte-for-byte the reviewed table, and still enforced", () => {
    /* The table as integrated at 8c4dca9 (player reporting, P3-N035): this exception's data is not touched by Escrow 2.1. */
    assert.equal(sha256Hex(JSON.stringify(CONDUCT_REVIEWERS_WIRING)), "648fd87a30e14b8682364cc43e8b274a4f6ad97acf202beb51853162b141f310");
    const file = "infra/aws/modules/single-host/templates/server.env.tftpl";
    failsNaming(check(mutate(file, after("GS_CONDUCT_REVIEWERS=", '${join(",", conduct_reviewers)}', '${join(";", conduct_reviewers)}'))), file, /pinned reviewer wiring/);
  });

  test("3. the pinned Escrow 2.1 delta is exactly the reviewed files; reversing it leaves no Escrow 2.1 token behind", () => {
    assert.equal(sha256Hex(normalizeLf(PATCH)), ESCROW21_TERRAFORM_PATCH_SHA256);
    const parsed = parsePinnedPatch(PATCH);
    assert.ok(parsed.ok);
    assert.deepEqual([...parsed.files.keys()].sort(), [...ESCROW21_TERRAFORM_FILES].sort());
    assert.ok([...ESCROW21_TERRAFORM_FILES].every((f) => f.startsWith("infra/aws/modules/") || f.startsWith("infra/aws/stacks/")));
    for (const [file, hunks] of parsed.files) {
      const reversed = reverseApplyPinnedHunks(escrowText(file), hunks);
      assert.ok(reversed.ok, file);
      const base = io.git(["cat-file", "blob", `${CERTIFIED_TERRAFORM_BASE}:${file}`]);
      assert.equal(base.status, 0, file);
      for (const token of ["remedy_signing_key", "remedy_key_count", "RemedyKey", "ClockFinalityHeldTables", "c1-clock-finality-held", "c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219"])
        assert.equal(reversed.text.split(token).length, normalizeLf(base.stdout).split(token).length, `${file}: ${token} enters only through the pinned delta`);
    }
  });

  test("4 / 8. an unrelated change in every protected area -- app, ledger, single-host, each stack -- still fails", () => {
    const files = [
      "infra/aws/modules/app/iam.tf", "infra/aws/modules/app/ecs.tf", "infra/aws/modules/app/alarm-contract.json", "infra/aws/modules/app/variables.tf",
      "infra/aws/modules/ledger/main.tf", "infra/aws/modules/ledger/versions.tf",
      "infra/aws/modules/single-host/iam.tf", "infra/aws/modules/single-host/host.tf", "infra/aws/modules/single-host/variables.tf",
      "infra/aws/stacks/app/main.tf", "infra/aws/stacks/ledger/main.tf", "infra/aws/stacks/single-host/main.tf", "infra/aws/stacks/single-host/outputs.tf",
    ];
    for (const file of files) failsNaming(check(mutate(file, (t) => `${t}# unrelated drift\n`)), file);
    for (const file of ["infra/aws/modules/single-host/iam.tf", "infra/aws/modules/single-host/host.tf"])
      failsNaming(check(mutate(file, (t) => `${t}# unrelated drift\n`), ["infra/aws/modules/single-host"]), file);
    failsNaming(check(new Map([["infra/aws/modules/app/extra.tf", 'resource "null_resource" "x" {}\n']])), "infra/aws/modules/app/extra.tf", /no reviewed exception/);
    failsNaming(check(new Map([["infra/aws/modules/ledger/main.tf", null]])), "infra/aws/modules/ledger/main.tf");
  });

  test("5. a line inserted beside a pinned Escrow 2.1 change fails (app and single-host)", () => {
    const appIam = "infra/aws/modules/app/iam.tf";
    failsNaming(check(mutate(appIam, after('sid       = "RemedyKeyPublicKey"', "\n", '\n      # adjacent\n'))), appIam, /pinned Escrow 2\.1 change/);
    const hostIam = "infra/aws/modules/single-host/iam.tf";
    failsNaming(check(mutate(hostIam, after('Sid      = "RemedyKeyPublicKey"', "\n", '\n        Extra    = "x"\n'))), hostIam, /pinned Escrow 2\.1 change/);
    const stack = "infra/aws/stacks/app/main.tf";
    failsNaming(check(mutate(stack, after("remedy_signing_key                = var.remedy_signing_key", "\n", "\n  unrelated = true\n"))), stack, PINNED_CHANGE);
  });

  test("6. deleting, altering, moving or reverting a required pinned line fails", () => {
    const appIam = "infra/aws/modules/app/iam.tf";
    failsNaming(check(mutate(appIam, after('sid       = "RemedyKeySignDigestOnly"', '        values   = ["DIGEST"]\n', ""))), appIam, /pinned Escrow 2\.1 change/);
    failsNaming(check(mutate(appIam, after('sid       = "RemedyKeyPublicKey"', '["kms:GetPublicKey"]', '["kms:GetPublicKey", "kms:Decrypt"]'))), appIam, /pinned Escrow 2\.1 change/);
    const stack = "infra/aws/stacks/ledger/main.tf";
    failsNaming(check(mutate(stack, (t) => t.replace("  remedy_key_count     = var.remedy_key_count\n", ""))), stack, /pinned Escrow 2\.1 change/);
    failsNaming(check(mutate(stack, (t) => t.replace("  remedy_key_count     = var.remedy_key_count\n", "").replace(/\n}\n/, "\n  remedy_key_count     = var.remedy_key_count\n}\n"))), stack);
    const parsed = parsePinnedPatch(PATCH);
    assert.ok(parsed.ok);
    const file = "infra/aws/modules/single-host/variables.tf";
    const reverted = reverseApplyPinnedHunks(read(file), parsed.files.get(file) ?? []);
    assert.ok(reverted.ok);
    failsNaming(check(new Map([[file, reverted.text]])), file, /pinned Escrow 2\.1 change/);
  });

  test("7. a missing certified base, a non-git tree or a tampered patch FAILS -- never a silent pass", () => {
    const gone = check(undefined, ALL, { base: "0123456789abcdef0123456789abcdef01234567" });
    assert.equal(gone.length, 1);
    assert.match(gone[0], /certified Terraform base 0123456789abcdef0123456789abcdef01234567 is not available in this checkout .* FAILS rather than skip/);
    const exported = fs.mkdtempSync(path.join(os.tmpdir(), "tf-exported-"));
    try {
      const r = terraformDriftProblems(terraformDriftIo(exported), { scope: ALL, patchText: PATCH, ludumPatchText: LUDUM });
      assert.equal(r.length, 1);
      assert.match(r[0], /083d0668556c05a84eb8b3e5befc4e973544aa9a is not available .* FAILS rather than skip/);
    } finally {
      fs.rmSync(exported, { recursive: true, force: true });
    }
    assert.match(terraformDriftProblems(terraformDriftIo(path.join(os.tmpdir(), "tf-no-such-dir-x7")), { scope: ALL, patchText: PATCH, ludumPatchText: LUDUM })[0], /FAILS rather than skip/);
    assert.match(check(undefined, ALL, { patchText: PATCH.replace("+variable \"remedy_signing_key\" {", "+variable \"remedy_signing_keys\" {") })[0], /does not match its pinned SHA-256/);
  });

  test("9. no future checksum, IAM, alarm or KMS drift hides behind the exception", () => {
    const tf = "infra/aws/modules/app/tests/compute_none.tftest.hcl";
    failsNaming(check(mutate(tf, (t) => t.replace("c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219", "d".repeat(64)))), tf);
    const appTf = "infra/aws/modules/app/tests/app.tftest.hcl";
    failsNaming(check(mutate(appTf, (t) => t.replace("c3bd0618615e0d8688f71860a90f235a796b0152be84e2489ce6639e3a218219", "e".repeat(64)))), appTf);
    const hostIam = "infra/aws/modules/single-host/iam.tf";
    failsNaming(check(mutate(hostIam, after('Sid       = "RemedyKeySignDigestOnly"', '["kms:Sign"]', '["kms:*"]'))), hostIam);
    failsNaming(check(mutate(hostIam, after('Sid       = "RemedyKeySignDigestOnly"', "Resource  = [var.remedy_signing_key]", 'Resource  = ["*"]'))), hostIam);
    const appIam = "infra/aws/modules/app/iam.tf";
    failsNaming(check(mutate(appIam, after('sid       = "RemedyKeyReadOnly"', '"kms:ListGrants"]', '"kms:ListGrants", "kms:CreateGrant"]'))), appIam);
    const alarms = "infra/aws/modules/app/alarm-contract.json";
    failsNaming(check(mutate(alarms, after('"c1-clock-finality-held"', '"threshold": 1', '"threshold": 2'))), alarms);
    failsNaming(check(mutate(alarms, after('"c1-clock-finality-held"', '"suppressible": false', '"suppressible": true'))), alarms);
    const ledger = "infra/aws/modules/ledger/main.tf";
    failsNaming(check(mutate(ledger, (t) => t.replace('"gs:remedy-key" = trimprefix(each.key, "remedy-")', '"gs:remedy-key" = each.key'))), ledger);
    failsNaming(check(mutate(ledger, (t) => t.replace("customer_master_key_spec", "customer_master_key_spec "))), ledger);
    const vars = "infra/aws/modules/ledger/variables.tf";
    failsNaming(check(mutate(vars, (t) => t.replace("var.remedy_key_count <= 16", "var.remedy_key_count <= 64"))), vars);
  });

  test("review I1: the patch's SHA-256 is pinned here too, and every pinned file's line count is recorded", () => {
    assert.equal(ESCROW21_TERRAFORM_PATCH_SHA256, "e2bd4914b03f1034bdf592fae3896580cf8bd85d3245f99f5b92f02965a64fb7");
    assert.deepEqual([...ESCROW21_TERRAFORM_LINE_COUNTS.keys()].sort(), [...ESCROW21_TERRAFORM_FILES].sort());
    for (const [file, count] of ESCROW21_TERRAFORM_LINE_COUNTS) assert.equal(escrowText(file).split("\n").length - 1, count, file);
  });

  test("review H2: a content line beginning with ++ or -- is judged like any other (no header look-alike slips through)", () => {
    const env = "infra/aws/modules/single-host/templates/server.env.tftpl";
    for (const scope of [ALL, ["infra/aws/modules/single-host"]])
      failsNaming(check(mutate(env, (t) => `${t}++\nGS_AWS_CONFIG_PARAMETER=arn:aws:ssm:us-east-1:999999999999:parameter/attacker\n`), scope), env);
    const locals = "infra/aws/modules/single-host/locals.tf";
    failsNaming(check(mutate(locals, (t) => `${t}++ = 1\n`)), locals);
    failsNaming(check(mutate(locals, (t) => t.replace("\n", "\n-- \n"))), locals);
  });

  test("review M2: nothing can be appended after a file's last pinned hunk -- not even in the tftest files the conduct rule admits runs to", () => {
    for (const file of ["infra/aws/modules/app/tests/app.tftest.hcl", "infra/aws/modules/single-host/tests/single-host.tftest.hcl"]) {
      failsNaming(check(mutate(file, (t) => `${t}\nrun "evil" {\n  command = plan\n  # conduct_reviewers\n}\n`)), file, PINNED_CHANGE);
      failsNaming(check(mutate(file, (t) => `${t}override_data {\n  target = data.aws_iam_policy_document.task\n  values = {}\n}\n`)), file, PINNED_CHANGE);
    }
  });

  /* A throwaway repository (the regression tests below need real git index states; the real tree is never touched). */
  const scratch = (files: Record<string, string>, after?: (git: (...a: string[]) => string, dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-guard-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    git("init", "-q");
    fs.mkdirSync(path.join(dir, "x"));
    fs.writeFileSync(path.join(dir, "x/main.tf"), "# base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const baseSha = git("rev-parse", "HEAD").trim();
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    after?.(git, dir);
    return { dir, baseSha, problems: () => terraformDriftProblems(terraformDriftIo(dir), { scope: ["x"], patchText: PATCH, ludumPatchText: LUDUM, base: baseSha }), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  test("review H1: a file git would C-quote (non-ASCII, quote, backslash, tab) is refused, tracked or untracked -- never read as absent", () => {
    /* PORTABLE (Windows): the guard learns names ONLY from git's NUL-separated listings, never from the filesystem. So the
       adversarial names reach it the way git reports them on every platform:
         - TRACKED: the exact name is put in the index by `update-index --cacheinfo` (no file on disk is needed, so
           Windows -- which cannot create `a"b.tf`, a tab, or a backslash inside a name -- builds the same tree) and
           committed: `ls-files` / `diff` / `ls-tree` then name it exactly as on Linux;
         - UNTRACKED: the exact `ls-files -z --others` answer git gives for such a file is laid over the real scratch
           repository's DriftIo (only that one listing; every other git call is real) -- and, wherever the OS can hold the
           exact name, the real file is created as well and judged the same way.
       Either way the name must be REFUSED by name ("refuses to judge"), never read as an absent file. */
    const BODY = 'resource "aws_iam_policy" "p" {}\n';
    const untrackedListing = (io: ReturnType<typeof terraformDriftIo>, name: string): ReturnType<typeof terraformDriftIo> => ({
      ...io,
      git: (args) => {
        const r = io.git(args);
        const others = args.includes("ls-files") && args.includes("--others") && !args.includes("--ignored");
        return others && r.status === 0 ? { status: 0, stdout: `${r.stdout}${name}\0` } : r;
      },
    });
    const exactlyCreatable = (dir: string, name: string): boolean => {
      try {
        fs.writeFileSync(path.join(dir, ...name.split("/")), BODY, { flag: "wx" });
      } catch {
        return false;
      }
      return fs.readdirSync(path.join(dir, "x")).includes(name.slice("x/".length));
    };
    for (const name of ["x/é.tf", 'x/a"b.tf', "x/a\\b.tf", "x/a\tb.tf", "x/a b.tf"]) {
      const untracked = scratch({});
      try {
        const listed = terraformDriftProblems(untrackedListing(terraformDriftIo(untracked.dir), name), { scope: ["x"], patchText: PATCH, ludumPatchText: LUDUM, base: untracked.baseSha });
        assert.ok(listed.some((m) => /refuses to judge/.test(m)), `untracked (as git lists it) ${JSON.stringify(name)}: ${JSON.stringify(listed)}`);
        if (exactlyCreatable(untracked.dir, name)) {
          const p = untracked.problems();
          assert.ok(p.some((m) => /refuses to judge/.test(m)), `untracked (on disk) ${JSON.stringify(name)}: ${JSON.stringify(p)}`);
        }
      } finally {
        untracked.done();
      }
      const committed = scratch({}, (git, dir) => {
        const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: BODY, encoding: "utf8" }).stdout.trim();
        assert.match(blob, /^[0-9a-f]{40,64}$/);
        git("-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
        /* No pathspec: Git for Windows reads a backslash in a pathspec as a separator. The full listing names it exactly. */
        assert.ok(git("-c", "core.quotePath=false", "ls-files", "-z").split("\0").includes(name), `the index holds exactly ${JSON.stringify(name)}`);
        git("commit", "-q", "-m", "drift");
      });
      try {
        assert.ok(committed.problems().some((m) => /refuses to judge/.test(m)), `tracked ${JSON.stringify(name)}: ${JSON.stringify(committed.problems())}`);
      } finally {
        committed.done();
      }
    }
    const control = scratch({});
    try {
      assert.deepEqual(control.problems(), [], "the scratch base alone is clean");
      assert.deepEqual(terraformDriftProblems(untrackedListing(terraformDriftIo(control.dir), "x/plain.tf"), { scope: ["x"], patchText: PATCH, ludumPatchText: LUDUM, base: control.baseSha }).filter((m) => /refuses to judge/.test(m)), [], "a safe name is never refused");
    } finally {
      control.done();
    }
  });

  test("review M1: git-ignored files Terraform loads (overrides, auto tfvars, any .tf) are refused; named operator tfvars and .terraform/ are not", () => {
    const ignore = "*.tfvars\n!*.tfvars.example\noverride.tf\n*_override.tf\n*_override.tf.json\n.terraform/\nlocal-*.tf\n";
    for (const name of ["x/override.tf", "x/iam_override.tf", "x/iam_override.tf.json", "x/a.auto.tfvars", "x/terraform.tfvars", "x/local-extra.tf"]) {
      const r = scratch({ ".gitignore": ignore, [name]: "# loaded\n" }, (git) => {
        git("add", ".gitignore");
        git("commit", "-q", "-m", "ignore");
      });
      try {
        assert.ok(r.problems().some((m) => m.startsWith(`${name}: git-ignored, but Terraform loads it`)), name);
      } finally {
        r.done();
      }
    }
    const fine = scratch({ ".gitignore": ignore, "x/staging.tfvars": "a = 1\n", "x/.terraform/providers/p.tf": "# cache\n" }, (git) => {
      git("add", ".gitignore");
      git("commit", "-q", "-m", "ignore");
    });
    try {
      assert.deepEqual(fine.problems(), []);
    } finally {
      fine.done();
    }
  });

  test("review M3: a skip-worktree or assume-unchanged entry is refused (git would hide its edits)", () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      const r = scratch({}, (git, dir) => {
        git("update-index", flag, "x/main.tf");
        fs.writeFileSync(path.join(dir, "x/main.tf"), 'resource "aws_iam_policy" "p" {}\n');
      });
      try {
        assert.ok(r.problems().some((m) => m.startsWith("x/main.tf: its index entry is flagged")), flag);
      } finally {
        r.done();
      }
    }
  });

  test("re-review: local repository state cannot hide a change -- a replace ref or a clean filter still fails", () => {
    const evil = 'resource "aws_iam_policy" "p" {}\n';
    const replaced = scratch({}, (git, dir) => {
      const baseBlob = git("rev-parse", "HEAD:x/main.tf").trim();
      fs.writeFileSync(path.join(dir, "evil.txt"), evil);
      const evilBlob = git("hash-object", "-w", "evil.txt").trim();
      fs.rmSync(path.join(dir, "evil.txt"));
      git("replace", baseBlob, evilBlob);
      fs.writeFileSync(path.join(dir, "x/main.tf"), evil);
    });
    try {
      assert.ok(replaced.problems().some((m) => m.startsWith("x/main.tf:")), JSON.stringify(replaced.problems()));
    } finally {
      replaced.done();
    }
    const filtered = scratch({}, (git, dir) => {
      fs.writeFileSync(path.join(dir, ".git/info/attributes"), "x/main.tf filter=hide\n");
      git("config", "filter.hide.clean", "printf '# base\\n'");
      git("config", "filter.hide.smudge", "cat");
      fs.writeFileSync(path.join(dir, "x/main.tf"), evil);
      assert.equal(git("diff", "--name-only").trim(), "", "the filter does hide the edit from git diff");
    });
    try {
      assert.ok(filtered.problems().some((m) => m.startsWith("x/main.tf:")), JSON.stringify(filtered.problems()));
    } finally {
      filtered.done();
    }
  });

  test("the patch parser and the reverse application are strict", () => {
    const one = "diff --git a/x.tf b/x.tf\n--- a/x.tf\n+++ b/x.tf\n@@ -1,2 +1,3 @@\n a\n+b\n c\n";
    const parsed = parsePinnedPatch(one);
    assert.ok(parsed.ok);
    const hunks = parsed.files.get("x.tf") ?? [];
    assert.deepEqual(reverseApplyPinnedHunks("a\nb\nc\n", hunks), { ok: true, text: "a\nc\n" });
    assert.equal(reverseApplyPinnedHunks("a\nb\nc\r\n", hunks).ok, true, "CRLF working trees normalize");
    for (const bad of ["z\na\nb\nc\n", "a\nb\nb\nc\n", "a\nc\n", "a\nb\nc", null]) assert.equal(reverseApplyPinnedHunks(bad, hunks).ok, false, JSON.stringify(bad));
    for (const bad of [
      "diff --git a/x.tf b/x.tf\nnew file mode 100644\n--- /dev/null\n+++ b/x.tf\n@@ -0,0 +1 @@\n+a\n",
      "diff --git a/x.tf b/x.tf\n--- a/x.tf\n+++ b/x.tf\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n",
      "diff --git a/x.tf b/x.tf\n--- a/x.tf\n+++ b/x.tf\n@@ -1,2 +1,3 @@\n a\n+b\n",
      "diff --git a/x.tf b/y.tf\n--- a/x.tf\n+++ b/y.tf\n@@ -1 +1 @@\n-a\n+b\n",
    ])
      assert.equal(parsePinnedPatch(bad).ok, false, bad);
  });
});

/* LUDUM ORIGINS: the THIRD exception -- a pinned patch, required and exact, reverse-applied BEFORE the Escrow 2.1 hunks. */
describe("LUDUM: the pinned Ludum-origins Terraform delta", () => {
  const NL = "\n";
  test("the patch is pinned: its SHA-256, its files, each file's line count, and it parses", () => {
    assert.equal(sha256Hex(normalizeLf(LUDUM)), LUDUM_TERRAFORM_PATCH_SHA256);
    const parsed = parsePinnedPatch(LUDUM);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.problem);
    assert.deepEqual([...parsed.files.keys()].sort(), [...LUDUM_TERRAFORM_FILES].sort());
    for (const file of LUDUM_TERRAFORM_FILES) assert.equal(read(file).split(NL).length - 1, LUDUM_TERRAFORM_LINE_COUNTS.get(file), file);
    for (const file of LUDUM_TERRAFORM_FILES) assert.ok(!file.startsWith("infra/aws/modules/single-host") && !file.startsWith("infra/aws/stacks/single-host"), `${file}: never the host's user_data / environment`);
  });
  test("the tree passes: the base plus exactly the four reviewed exceptions", () => {
    assert.deepEqual(check(), []);
  });
  test("a tampered or empty Ludum patch FAILS (never a skip)", () => {
    const tampered = LUDUM.replace('+  default     = []', '+  default     = ["https://x.example.org"]');
    assert.notEqual(tampered, LUDUM, "the tamper matched");
    assert.match(check(undefined, ALL, { ludumPatchText: tampered })[0], /Ludum-origins Terraform patch does not match its pinned SHA-256/);
    assert.match(check(undefined, ALL, { ludumPatchText: "" })[0], /does not match its pinned SHA-256/);
  });
  test("a line beside the Ludum change, an altered Ludum line, or the change removed: FAIL by name", () => {
    const beside = check(mutate("infra/aws/modules/app/locals.tf", after("length(var.ludum_origins) > 0", "}))", `}))${NL}  # beside`)));
    assert.ok(beside.some((p) => /locals\.tf: the pinned Ludum-origins change is missing, altered, moved or has a line beside it/.test(p)), beside.join(NL));
    const altered = check(mutate("infra/aws/modules/app/variables.tf", (t) => t.replace("length(var.ludum_origins) <= 8", "length(var.ludum_origins) <= 80")));
    assert.ok(altered.some((p) => /variables\.tf: the pinned Ludum-origins change/.test(p)), altered.join(NL));
    const gone = check(mutate("infra/aws/stacks/app/main.tf", (t) => t.replace(`  ludum_origins                     = var.ludum_origins${NL}`, "")));
    assert.ok(gone.some((p) => /main\.tf: the pinned Ludum-origins change/.test(p)), gone.join(NL));
  });
  test("a Ludum origin anywhere in the single-host module is unadmitted drift (the host's user_data never carries it)", () => {
    const host = check(mutate("infra/aws/modules/single-host/templates/server.env.tftpl", (t) => `${t}GS_LUDUM_ORIGINS=https://ludum.example.org${NL}`));
    assert.ok(host.some((p) => /server\.env\.tftpl/.test(p)), host.join(NL));
  });
});
