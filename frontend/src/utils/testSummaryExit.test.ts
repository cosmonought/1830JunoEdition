/** @jest-environment node */
// frontend/src/utils/testSummaryExit.test.ts -- R12-W1: `test-summary.ps1` must exit with the suite's status.
//
// ==================================================================
//  THE FALSE PASS
// ==================================================================
//
// The owner's Windows gate printed "PASS: Frontend full test summary" directly above Jest's own
// "Test Suites: 6 failed". The script ran `npm test`, formatted the report and fell off the end -- exit 0 whatever
// Jest said -- and the gate trusted the exit code, as a gate should. So the fix is in the script, and so is this
// test: it runs the REAL script, unmodified, under the PowerShell the owner runs it with, against a fake `npm`
// placed first on PATH, and reads the process exit code.
//
// WHICH POWERSHELL. On Windows, `powershell.exe` (Windows PowerShell 5.1 -- the one the script's header tells the
// owner to use, and the reason the script is ASCII-only). Elsewhere `pwsh` if it is installed; with neither, the
// suite is skipped by name rather than passing on nothing.
//
// NOTHING OF THE OWNER'S IS TOUCHED: the script is copied into a temporary directory, and it writes its
// `test-output.txt` beside itself -- there, not in `frontend/`.

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const SCRIPT = path.join(__dirname, "..", "..", "test-summary.ps1");

function findPowerShell(): string | null {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
  for (const shell of candidates) {
    const probe = spawnSync(shell, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8", timeout: 60_000 });
    if (!probe.error && probe.status === 0) return shell;
  }
  return null;
}

const SHELL = findPowerShell();
const describeWithPowerShell = SHELL ? describe : describe.skip;

/** A marker the fake prints, so a test can prove the fake -- not the real npm -- is what ran. */
const MARKER = "R12W1-FAKE-NPM";

const FAILING_RUN = [
  "FAIL src/utils/fake.test.ts",
  "Summary of all failing tests",
  "FAIL src/utils/fake.test.ts",
  "  * fake > fails",
  "",
  "    expect(received).toBe(expected)",
  "",
  "Test Suites: 1 failed, 1 passed, 2 total",
  "Tests:       1 failed, 3 passed, 4 total",
  MARKER,
].join("\n");

const PASSING_RUN = ["PASS src/utils/fake.test.ts", "Test Suites: 2 passed, 2 total", "Tests:       4 passed, 4 total", MARKER].join("\n");

const NO_TOTALS = ["something went wrong before Jest printed anything", MARKER].join("\n");

let dir = "";

beforeAll(() => {
  if (!SHELL) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r12w1-test-summary-"));
  fs.copyFileSync(SCRIPT, path.join(dir, "test-summary.ps1"));
  /* The fake `npm`: prints `fake-output.txt` and exits with FAKE_NPM_EXIT. Windows gets both spellings PowerShell
     may resolve `npm` to (a `.ps1` and a `.cmd`, as Node's own install ships), so whichever it picks is the fake. */
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "npm.cmd"), '@echo off\r\ntype "%~dp0fake-output.txt"\r\nexit /b %FAKE_NPM_EXIT%\r\n');
    fs.writeFileSync(
      path.join(dir, "npm.ps1"),
      "Get-Content (Join-Path $PSScriptRoot 'fake-output.txt')\r\nexit [int]$env:FAKE_NPM_EXIT\r\n",
    );
  } else {
    const fake = path.join(dir, "npm");
    fs.writeFileSync(fake, '#!/bin/sh\ncat "$(dirname "$0")/fake-output.txt"\nexit "$FAKE_NPM_EXIT"\n');
    fs.chmodSync(fake, 0o755);
  }
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the copied script against the fake npm. */
function runSummary(output: string, npmExit: number): { code: number | null; stdout: string; saved: string } {
  fs.writeFileSync(path.join(dir, "fake-output.txt"), output + "\n");
  const outputFile = path.join(dir, "test-output.txt");
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  /* Windows' environment block spells it `Path`; set whichever key is there rather than adding a second one. */
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_NPM_EXIT: String(npmExit) };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = dir + path.delimiter + (env[pathKey] ?? "");
  const run = spawnSync(
    SHELL as string,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "test-summary.ps1"), "-NoColor"],
    { cwd: dir, env, encoding: "utf8", timeout: 120_000 },
  );
  if (run.error) throw run.error;
  const saved = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
  return { code: run.status, stdout: `${run.stdout}${run.stderr}`, saved };
}

describeWithPowerShell(`test-summary.ps1 exits with the suite's status (R12-W1; ${SHELL ?? "no PowerShell"})`, () => {
  jest.setTimeout(180_000);

  it("exits nonzero when Jest fails -- and still saves the run and prints the summary", () => {
    const run = runSummary(FAILING_RUN, 1);
    expect(run.saved).toContain(MARKER);
    expect(run.saved).toContain("Test Suites: 1 failed, 1 passed, 2 total");
    expect(run.stdout).toContain("Tests:       1 failed, 3 passed, 4 total");
    expect(run.stdout).toContain("RESULT: FAIL (npm test exited 1)");
    expect(run.code).toBe(1);
  });

  it("exits 0 when the suite passed, which is the control", () => {
    const run = runSummary(PASSING_RUN, 0);
    expect(run.saved).toContain(MARKER);
    expect(run.stdout).toContain("No failing tests.");
    expect(run.stdout).toContain("RESULT: PASS");
    expect(run.code).toBe(0);
  });

  it("preserves npm's own nonzero status rather than flattening it", () => {
    expect(runSummary(FAILING_RUN, 7).code).toBe(7);
  });

  it("never turns reported failures into a 0, even if npm's status says 0", () => {
    const run = runSummary(FAILING_RUN, 0);
    expect(run.stdout).toContain("RESULT: FAIL (npm test exited 0 but Jest reported failures)");
    expect(run.code).toBe(1);
  });

  it("never reports a pass for a run that printed no totals", () => {
    const run = runSummary(NO_TOTALS, 0);
    expect(run.stdout).toContain("printed no Jest totals");
    expect(run.code).toBe(1);
  });
});

describe("test-summary.ps1 keeps the exit-status wiring (R12-W1)", () => {
  /* The source half, so a machine with no PowerShell still notices the fix being undone. */
  const script = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n?/g, "\n");

  it("captures npm's status on the line after the run and exits with the verdict", () => {
    const run = "npm test -- --watchAll=false --silent @Jest 2>&1 | ForEach-Object { \"$_\" } | Out-File -Encoding utf8 test-output.txt\n";
    expect(script).toContain("$global:LASTEXITCODE = $null\n" + run + "$npmExit = $global:LASTEXITCODE\n");
    expect(script.trimEnd().endsWith("exit $code")).toBe(true);
  });

  it("stays ASCII, which Windows PowerShell 5.1 needs to parse a file without a byte-order mark", () => {
    expect(Array.from(script).filter((ch) => ch.charCodeAt(0) > 0x7f)).toEqual([]);
  });
});
