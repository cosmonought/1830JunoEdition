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
// PHASE 1 CERTIFICATION CLOSURE: the three gs-host.ps1 regressions run AS DOCUMENTED (no -Target) under Windows
// PowerShell 5.1, which leaves $PSScriptRoot empty in an advanced script's parameter defaults under `powershell -File`
// (PowerShell/PowerShell#4688) -- so no PowerShell script here may read its own path in param(); each test resolves its
// default target in its body, and prints the header / totals the owner gate judges.

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

/* PowerShell text with its comments and literal ('...') strings blanked -- what is left can name a variable -- and, for
   bracket matching, its expandable ("...") strings blanked too. Lengths and line breaks are kept, so offsets agree. */
const blankPs = (s: string): { matchable: string; referable: string } => {
  const m = s.split("");
  const r = s.split("");
  const wipe = (into: string[], from: number, to: number) => {
    for (let k = from; k < to && k < into.length; k++) if (into[k] !== "\n") into[k] = " ";
  };
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("<#", i)) {
      const e = s.indexOf("#>", i + 2);
      const end = e < 0 ? s.length : e + 2;
      wipe(m, i, end);
      wipe(r, i, end);
      i = end - 1;
    } else if (s[i] === "#") {
      const e = s.indexOf("\n", i);
      const end = e < 0 ? s.length : e;
      wipe(m, i, end);
      wipe(r, i, end);
      i = end - 1;
    } else if (s[i] === "'") {
      let j = i + 1;
      for (; j < s.length; j++) if (s[j] === "'") { if (s[j + 1] === "'") j++; else break; }
      wipe(m, i, j + 1);
      wipe(r, i, j + 1);
      i = j;
    } else if (s[i] === '"') {
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "`") j++;
        else if (s[j] === '"') { if (s[j + 1] === '"') j++; else break; }
      }
      wipe(m, i, j + 1);
      i = j;
    } else if (s[i] === "`") i++; // an escaped character outside quotes (a line continuation, `#, `')
  }
  return { matchable: m.join(""), referable: r.join("") };
};
/* The index of the bracket closing the one at `open` (quotes and comments already blanked); throws when unbalanced. */
const closingBracket = (s: string, open: number): number => {
  const want: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "`") i++;
    else if (c === "(" || c === "[" || c === "{") want.push(c === "(" ? ")" : c === "[" ? "]" : "}");
    else if (c === ")" || c === "]" || c === "}") {
      if (want.pop() !== c) throw new Error(`an unbalanced '${c}' at offset ${i}`);
      if (want.length === 0) return i;
    }
  }
  throw new Error(`the '${s[open]}' at offset ${open} never closes`);
};
/* A script's OWN param(...) block -- its first statement, after comments, `using` lines and attributes such as
   [CmdletBinding()] -- with comments and literal strings blanked; null when the script has none. */
const scriptParamBlock = (source: string): string | null => {
  const { matchable, referable } = blankPs(source.replace(/\r\n?/g, "\n"));
  let i = 0;
  for (;;) {
    while (i < matchable.length && /\s/.test(matchable[i])) i++;
    if (/^using\s/i.test(matchable.slice(i, i + 6))) {
      const e = matchable.indexOf("\n", i);
      i = e < 0 ? matchable.length : e + 1;
    } else if (matchable[i] === "[") i = closingBracket(matchable, i) + 1;
    else break;
  }
  const m = /^param\s*\(/i.exec(matchable.slice(i));
  if (m === null) return null;
  const open = i + m[0].length - 1;
  return referable.slice(open, closingBracket(matchable, open) + 1);
};
/* The automatic variables Windows PowerShell 5.1 has not set while it binds an advanced script's parameters. */
const SELF_PATH = /\$\{?(?:PSScriptRoot|PSCommandPath|MyInvocation)\b/i;
const PS_TESTS = ["gs-host-stderr.test.ps1", "gs-host-role-probe.test.ps1", "gs-host-install-script.test.ps1"] as const;
const trackedPowerShell = (): string[] => {
  const r = git(["ls-files", "-z", "--", "*.ps1", "*.psm1"]);
  if (r.status === 0) return r.stdout.split("\0").filter((f) => f !== "");
  const found: string[] = []; // an exported tree (no git): walk it
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (![".git", "node_modules", "dist", "evidence", ".terraform"].includes(e.name)) walk(p); }
      else if (/\.psm?1$/i.test(e.name)) found.push(p);
    }
  };
  walk("");
  return found;
};

describe("PHASE 1 CERTIFICATION CLOSURE: the gs-host PowerShell regressions run as documented under Windows PowerShell 5.1", () => {
  test("the param() scanner finds a script's own block, ignores comments, literal strings and functions, and sees the 5.1 trap (self-test)", () => {
    const broken = "# a header\n[CmdletBinding()]\nparam([string]$Target = (Join-Path (Split-Path -Parent $PSScriptRoot) 'gs-host.ps1'))\n$x = 1\n";
    assert.equal(scriptParamBlock(broken)?.replace(/\s+/g, " "), "([string]$Target = (Join-Path (Split-Path -Parent $PSScriptRoot) ))", "its literal string blanked");
    assert.match(scriptParamBlock(broken) ?? "", SELF_PATH, "the pre-fix default is caught");
    const quiet = "<#\n.SYNOPSIS\n  param($No = $PSScriptRoot)\n#>\n#requires -Version 5.1\nusing namespace System.IO\n[CmdletBinding(SupportsShouldProcess = $true)]\n[OutputType([string])]\nParam(\n  # ) $PSScriptRoot in a comment\n  [string]$A = 'it''s ) $PSScriptRoot',\n  [string]$B = \"q `\" )\",\n  [ValidateSet('x', 'y')][string]$C = 'x'\n)\nfunction f { param($D = $PSScriptRoot) }\n$here = $PSScriptRoot\n";
    const block = scriptParamBlock(quiet) ?? "";
    assert.ok(block.startsWith("(\n") && block.endsWith("\n)") && block.includes("[ValidateSet(") && block.includes("$C ="), block);
    assert.doesNotMatch(block, SELF_PATH, "a comment, a literal string, a function's param() and the body are not the script's defaults");
    assert.match(scriptParamBlock("param($P = \"$PSScriptRoot\\x\")") ?? "", SELF_PATH, "an expandable string IS a reference");
    assert.match(scriptParamBlock("param($P = ${PSCommandPath})") ?? "", SELF_PATH);
    assert.match(scriptParamBlock("# CR-only line ends\r[CmdletBinding()]\rparam($P = $PSScriptRoot)\r") ?? "", SELF_PATH, "a comment ends at a lone CR too");
    assert.equal(scriptParamBlock("Set-StrictMode -Version 2\nparam($Late)\n"), null, "param() after a statement is not the script's");
    assert.throws(() => scriptParamBlock("param([string]$Open = (Join-Path a b)\n"), /never closes/);
  });

  test("no PowerShell script in the repository reads $PSScriptRoot / $PSCommandPath / $MyInvocation in its own param() block", () => {
    const files = trackedPowerShell();
    for (const t of PS_TESTS) assert.ok(files.includes(`infra/aws/single-host/tests/${t}`), t);
    for (const f of ["infra/aws/single-host/gs-host.ps1", "infra/aws/single-host/run-cost2c-owner-gate.ps1"]) assert.notEqual(scriptParamBlock(read(f)), null, `${f} has a param() block the scanner reads`);
    const offenders = files.filter((f) => fs.existsSync(path.join(REPO, f)) && SELF_PATH.test(scriptParamBlock(read(f)) ?? ""));
    assert.deepEqual(offenders, [], "resolve a script's own path in its body: Windows PowerShell 5.1 has not set these while it binds parameters");
  });

  test("what Windows PowerShell 5.1 runs here -- the owner gate, gs-host.ps1 and the three regressions -- is ASCII (5.1 reads a BOM-less script in the ANSI code page)", () => {
    for (const f of ["infra/aws/single-host/run-cost2c-owner-gate.ps1", "infra/aws/single-host/gs-host.ps1", ...PS_TESTS.map((t) => `infra/aws/single-host/tests/${t}`)]) {
      const bytes = fs.readFileSync(path.join(REPO, f));
      const at = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
      assert.equal(at, -1, `${f}: byte 0x${at < 0 ? "" : bytes[at].toString(16)} at offset ${at}`);
    }
  });

  test("each regression resolves its default target in its body, keeps -Target, and prints the header and totals the owner gate judges", () => {
    for (const t of PS_TESTS) {
      const src = read(`infra/aws/single-host/tests/${t}`);
      const name = /^gs-host-(.+)\.test\.ps1$/.exec(t)?.[1] ?? "";
      assert.equal(scriptParamBlock(src), "([ValidateNotNullOrEmpty()][string]$Target)", t);
      assert.ok(
        src.includes(
          [
            "if (-not $PSBoundParameters.ContainsKey('Target')) {",
            `  if ([string]::IsNullOrEmpty($MyInvocation.MyCommand.Path)) { throw 'gs-host-${name}.test: REFUSED: run it as a file (-File, or & <path>), or pass -Target <gs-host.ps1>' }`,
            "  $Target = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'gs-host.ps1'",
            "}",
            "$Target = (Resolve-Path -LiteralPath $Target).Path",
          ].join("\n"),
        ),
        `${t}: the default target is the gs-host.ps1 beside its tests folder, resolved in the body`,
      );
      assert.match(src, /^#   Windows PowerShell 5\.1:  powershell -NoProfile -ExecutionPolicy Bypass -File \.\\infra\\aws\\single-host\\tests\\gs-host-[a-z-]+\.test\.ps1$/m, `${t}: the documented 5.1 command`);
      assert.ok(src.includes(`Write-Host "gs-host ${name} regression -- PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) -- $Target"`), `${t}: the header (engine, edition, target)`);
      assert.ok(src.includes(`Write-Host "gs-host ${name} regression: $($script:Passed) passed / $($script:Failed) failed"`), `${t}: the totals`);
      assert.match(src, /\nif \(\$script:Failed -gt 0\) \{ exit 1 \}\nexit 0\n$/, `${t}: exit 1 on any failed case`);
    }
  });
});
