// server/src/aws/deploy/migration/phase1FreshHost.test.ts
//
// PHASE 1 FRESH-HOST HARDENING (static; no AWS, no Docker): the live remediation of step 13's fresh-host refusal is
// pinned to the source it installs.
//   - runbook 13r's table: the CERTIFIED SHA-256 of each host script is this checkout's bytes, the REPLACED one the
//     host-create commit's (5b4756d) -- the owner types both into the live command, so they can never drift;
//   - the set 13r installs = the host scripts this pass changed = what host-script-install.sh and both gs-host twins
//     accept (nothing more can be installed that way);
//   - 13r's order (status, disarm, check, install, the SAME deploy -Measure), its never-list, and 22b's host-create
//     checkout;
//   - gs-preflight asks a LISTING for the one-server check (the live root cause: `inspect || printf absent`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/migration -> the repository
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
const BOOK = read("infra/aws/SINGLE_HOST_MIGRATION.md");
const HOST_CREATE = "5b4756dbd98e8d9abe5ed4bbdf4314466ef8045d";
const BIN = "infra/aws/modules/single-host/files/bin";
const FILES = ["gs-lib.sh", "gs-health", "gs-preflight"] as const;
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const r13 = (() => {
  const from = BOOK.search(/^13r\. /m);
  const to = BOOK.indexOf("### F. Prove it", from);
  assert.ok(from > 0 && to > from, "the runbook has step 13r before F");
  return BOOK.slice(from, to);
})();
const row = (file: string) => {
  const m = new RegExp("\\| `" + file.replace(/\./g, "\\.") + "` \\| `([0-9a-f]{64})` \\| `([0-9a-f]{64})` \\|").exec(r13);
  assert.ok(m !== null, `13r's table has a row for ${file}`);
  return { replaces: m[1], certified: m[2] };
};
const git = (args: string[]) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

describe("PHASE 1 FRESH-HOST HARDENING: runbook 13r is the source it installs", () => {
  test("the CERTIFIED SHA-256 in 13r's table is this checkout's bytes (LF), for every file it installs", () => {
    for (const f of FILES) assert.equal(row(f).certified, sha(read(`${BIN}/${f}`)), f);
  });

  test("the REPLACED SHA-256 is the host-create commit's bytes, and differs from the certified one", (t) => {
    for (const f of FILES) {
      const r = git(["show", `${HOST_CREATE}:${BIN}/${f}`]);
      if (r.status !== 0) {
        t.skip("not a checkout holding the host-create commit: the owner gate's clean clone covers it");
        return;
      }
      assert.equal(row(f).replaces, sha(r.stdout), f);
      assert.notEqual(row(f).replaces, row(f).certified, f);
    }
  });

  test("13r installs exactly the host scripts this pass changed -- and the installer and both gs-host twins accept exactly those", (t) => {
    const installer = read("infra/aws/single-host/host-script-install.sh");
    const allow = /case "\$name" in ([a-z.| -]+)\) ;; \*\) refuse 2/.exec(installer)?.[1].split("|").map((x) => x.trim()).sort();
    assert.deepEqual(allow, [...FILES].sort(), "host-script-install.sh's allowlist");
    assert.match(read("infra/aws/single-host/gs-host.ps1"), /\[ValidateSet\('gs-preflight', 'gs-lib\.sh', 'gs-health'\)\]\[string\]\$HostScript/);
    assert.match(read("infra/aws/single-host/gs-host.sh"), /case "\$name" in gs-preflight \| gs-lib\.sh \| gs-health\) ;;/);
    const r = git(["diff", "--name-only", HOST_CREATE, "--", BIN]);
    if (r.status !== 0) {
      t.skip("not a checkout holding the host-create commit");
      return;
    }
    assert.deepEqual(r.stdout.trim().split("\n").filter((x) => x !== "").sort(), FILES.map((f) => `${BIN}/${f}`).sort(), "every changed host script is installable, and nothing else changed");
  });

  test("13r's procedure: the live record, status, disarm, check then install in order, the SAME deploy -Measure; never a bypass", () => {
    assert.match(r13, /sh1-5b4756d-arm64-r1` = `sha256:df981e83477936b4c45ae9a225c3be08733487cf5dac923ed69315d88fc22086`/);
    assert.match(r13, /i-01fe56536bf591382/);
    const step = (n: number) => r13.search(new RegExp(`^    ${n}\\. `, "m"));
    for (let n = 1; n <= 5; n++) assert.ok(step(n) > 0 && (n === 1 || step(n) > step(n - 1)), `step ${n} in order`);
    assert.match(r13.slice(step(2), step(3)), /-Command stop -InstanceId i-01fe56536bf591382 -UntilDeploy/);
    assert.match(r13.slice(step(3), step(4)), /-Command install-script -InstanceId i-01fe56536bf591382 -HostScript <file> -Sha256 <certified> -ReplacesSha256 <replaces> -Check/);
    assert.match(r13.slice(step(3), step(4)), /`gs-lib\.sh`, `gs-health`, `gs-preflight`/);
    assert.match(r13.slice(step(4)), /result=installed/);
    assert.match(r13.slice(step(5)), /Step 13 again, EXACTLY as above \(same digest, same build, `-Measure`\)/);
    assert.match(r13, /\*\*Never:\*\* bypass `gs-preflight`, `systemctl start` or `docker run` by hand, or take the pool by hand/);
    assert.match(r13, /write_files` runs ONCE per instance/);
    assert.match(BOOK.slice(BOOK.search(/^22b\. /m), BOOK.search(/^22c\. /m)), /Capture it from a clean checkout of the HOST-CREATE commit `5b4756d`/);
  });

  test("the root cause stays fixed: gs-preflight's one-server check is a listing, never inspect with an 'absent' fallback", () => {
    const preflight = read(`${BIN}/gs-preflight`);
    assert.match(preflight, /states="\$\(docker container ls --all --filter 'name=\^\/\?gs-server\$' --format '\{\{\.State\}\}'\)" \\\n  \|\| die /);
    assert.doesNotMatch(preflight, /container inspect|printf 'absent'/);
  });
});
