<#
.SYNOPSIS
  RECON-1 OWNER GATE (COST-2C's runner, extended) -- the ONE validation sweep of the reconciled single-host migration
  candidate (recon/recon-1-pre-cost2c), run ONCE by the OWNER on the owner's machine.

.DESCRIPTION
  Runs every gate the RECON-1 candidate needs, cheapest first, and writes ONE consolidated log (stdout AND stderr of
  every command) plus a compact JSON summary under <repo>\evidence\owner-gates\ (ignored by Git):

     1  Environment / source   git HEAD, branch, `git status --short`, core.autocrlf, tool versions (never fails the
                               gate by itself; a dirty tree is reported prominently)
     2  Windows LF checkout    RECON-1A W-04: every eol=lf-pinned single-host file is LF IN THE WORKING TREE
                               (`git ls-files --eol`; an older clone keeps CRLF copies git calls clean: re-clone, or
                               `git rm -r -q --cached infra/aws/modules/single-host; git reset -q --hard`)
     3  Dependencies           RECON-1 owner-gate correction: `npm ci --ignore-scripts` (the Dockerfile's own contract:
                               locked, lifecycle scripts never run) in frontend\ and server\ from their package-lock
                               files -- a CLEAN CLONE needs nothing installed by hand. Fails closed: an npm ci failure,
                               a changed package-lock, or ANY tracked / unignored file changed by it FAILS (node_modules
                               is ignored); every later gate is then BLOCKED, never run over stale dependencies.
     4  Build                  the server TypeScript build (`npm run build`'s own command) = the typecheck
     5  RECON-1 authorization  deploy/migration/recon1AuthorizationGates (app-read-authorize, ledger-operator-journal,
                               X-09, the Terraform-made plans, plan-evidence.ps1's targets / CR record -- its PowerShell
                               test must RUN here: a SKIP of it FAILS the gate -- and host-cert's credential authority /
                               stale-host classification) + recon1SevenATargets (RECON-1 7A HOTFIX: 7a's target contract
                               with Terraform's required COST-1 move closure, against a real pre-COST-1 plan)
     6  COST-2B migration      deploy/migration/cost2bMigrationGuards
     7  COST-2C targeted       aws/deploy/hostcert/hostCert.test.js -- the host drills F7 / F8 / F9a / F9b / replacement,
                               the systemd / HOLD evidence judges, the drill lock, false-PASS / NOT-EVALUATED cases,
                               the bash templates and gs-exit-hold parity, the --host-transport-profile authority
                               (Git Bash: a SKIP here is NOT RUN, not PASS). Git Bash supplies everything these tests
                               ask of bash (bash -n, base64, sha256sum, timeout, nohup, mktemp, sed / grep against stub
                               docker / systemctl / curl / journalctl; no flock, no python), so the Windows run stays.
     8  COST-2C targeted       the SAME suite again in a genuine Linux userspace: the repository's pinned Node image
        (Linux)                (node:22-bookworm-slim, the server image's own base), the repository mounted READ-ONLY,
                               --network none, no credential passed; every test must run (no skip)
     9  COST-2A verifier       deploy/cost2aHostVerifier (+ W-02), operator/cost2aHostSnapshot (its .ps1 captures run
                               under Windows PowerShell / pwsh)
    10  JX-4C / P5             operator/jx4cOperatorEvidenceIam, runtime/p5IntCrossSlice
    11  Ownership / fencing    rooms/l5_3Ownership, conformance/fenceGap, aws/awsClients (import / binding guards),
                               conformance/l6_5bAlarms
    12  awsDeploy / stage-cert deploy/l5_8Deploy, staging/l6_6StagingCert, staging/rotationProof (incl. L6-14W1
                               04138ea), staging/restoreFencing
    13  COST-1 + portability   deploy/cost1SingleHost (W-03 / W-04 + the host-cert scripts' LF), runtime/singleHostMetrics
    13b PHASE-1 targeted       PHASE 1 CERTIFICATION CLOSURE: migration/phase1FreshHost (runbook 13r's install table, order
                               and never-list; the param() guard below), phase1RemainderRunbook (steps 13-25),
                               step9AcmeCompletion, staging/singleHostEdge (step 16's single-host edge probe),
                               staging/hostRoleProbe (F5 / F6). Their pins diff against 5b4756d and 083d066: a clone
                               without either (shallow) FAILS, and so does a SKIP of 13r's host-create pins
    13c PHASE-1 targeted       staging/hostRoleProbe again in the pinned Linux Node image (node:22-bookworm-slim, --network
        (Linux)                none, the repository READ-ONLY): F5 / F6's REAL host-role-probe.sh with the real gs-lib.sh on
                               a fake host runs only on Linux (it is SKIPPED on Windows), so it runs here; any skip FAILS
    13d gs-host.ps1            PHASE 1 CERTIFICATION CLOSURE: infra/aws/single-host/tests/gs-host-stderr / -role-probe /
        stderr / role-probe /  -install-script.test.ps1 -- three gates -- each run with its header's documented command
        install-script         (-NoProfile -ExecutionPolicy Bypass -File <test>, NO -Target: the test resolves the
        regression             candidate's own gs-host.ps1), plus -NonInteractive, in a child process. On Windows the
                               engine is WINDOWS POWERSHELL 5.1 (%SystemRoot%\System32\WindowsPowerShell\v1.0\
                               powershell.exe, with Windows PowerShell's own module path; missing = NOT RUN) and the test's
                               own header must say 5.1 / Desktop and name the candidate's gs-host.ps1; >= 25 / 38 / 27
                               passed, 0 failed, exit 0. Elsewhere they run under this PowerShell 7 and the summary says
                               WINDOWS POWERSHELL 5.1: NOT PROVEN -- a 5.1 PASS is never claimed where 5.1 cannot run.
    14  Terraform              fmt -check (infra/aws), `terraform test` in modules/single-host (20), modules/app (69),
                               modules/ledger (34); init -backend=false + validate in stacks/app, stacks/ledger,
                               stacks/single-host (mocked providers: no AWS account, no credentials)
    15  Single-host scripts    the COMPLETE infra/aws/modules/single-host/tests/host-scripts.test.sh in a genuine Amazon
                               Linux 2023 userspace (the production OS): an ephemeral, pinned amazonlinux:2023
                               container, `--rm`, the repository mounted READ-ONLY, no credential passed; dnf adds only
                               util-linux-core (flock) and findutils; the module is copied inside and its files/bin made
                               0755 exactly as cloud-init installs them; the suite's own stubs stand in for docker /
                               systemctl / curl / aws (offline) -- answering as the REAL CLIs do (PHASE 1 FRESH-HOST
                               HARDENING); it also runs 13r's host-script-install.sh / gs-host.sh install-script (the
                               operator's infra/aws/single-host is copied beside the module). Git Bash is NOT a
                               substitute (no flock, no python3).
    15b Single-host real       PHASE 1 FRESH-HOST HARDENING: tests/preflight-real-docker.test.sh against the REAL Docker
        Docker                 daemon (the socket mounted) with Amazon Linux 2023's OWN docker CLI (dnf's docker package,
                               the host's): gs-preflight's one-server check (no container, running / paused / restarting,
                               exited / created leftovers, daemon unreachable, odd stdout), stop_server, gs-health and
                               gs-run's argument vector (docker create, never started). The docker stub that let step 13's
                               fresh-host failure pass every offline gate is not in this path. It creates only gs-server /
                               gs-rt-* containers, removes them, and refuses to run if a gs-server container exists.
    16  Image smoke            OFFLINE with respect to AWS / ECR: `docker buildx build --load` of
        (amd64 run; arm64      infra/docker/game-server.Dockerfile for linux/amd64 AND linux/arm64 into LOCAL, disposable
        build + architecture)  tags (never --push, never an ECR login, never build-image.{sh,ps1}'s push path; BUILD_CA, if
                               set, is passed as the build_ca secret as build-image.sh does). For EACH platform: the build
                               (check-arch-neutral.cjs runs inside it) and the ARCHITECTURE PROOF without executing
                               anything -- image metadata = the platform AND the image's own /usr/local/bin/node an ELF of
                               that machine (docker create + docker cp; AArch64 = 183, x86-64 = 62). linux/amd64 then runs
                               COST-1's unchanged tests/image-smoke.sh (REQUIRED) from a pinned docker-cli container on the
                               host network with the Docker socket. The gate's images and containers are removed after.
    16b ARM64 runtime smoke    OWNER-GATE FIX 1: the linux/arm64 image-smoke.sh where this machine can EXECUTE arm64
                               (emulation) -> PASS / FAIL. Without emulation it is DEFERRED -- never PASS, never inferred
                               from amd64 -- to the REQUIRED live Graviton gate (SINGLE_HOST_MIGRATION.md step 12b, `gs-host
                               arm64-smoke`, before any edge cutover; `migration-guard edge-cutover` refuses the cutover
                               without its PASS), and ONLY when gate 16 passed and that live gate is in the runbook / guard.
    17  DynamoDB Local         the full `npm run test:dynamodb-local` corpus (JX-4B's money evidence and COST-2C's drill
                               lock -- hostCertLock.dynamoLocal.test.js -- are part of it). Starts ONE throw-away
                               `amazon/dynamodb-local:3.3.1` container (the repository's documented procedure) and
                               removes only that container -- unless GS_DYNAMODB_LOCAL_ENDPOINT is already set, which
                               is then used and nothing is started.
    18  Full server suite      the complete server `npm test` corpus (LAST: the longest gate; OWNER-RUN ONLY)

  Nothing here touches AWS, Juno or any remote resource. The script never edits, cleans, resets or stashes the tree.
  Exit code: 0 only when the OWNER SOURCE GATE passed -- EVERY gate PASS, the arm64 runtime smoke alone allowed to be
  DEFERRED (see 16b); 1 otherwise (a FAIL, a BLOCKED gate after a failed build, or a NOT RUN gate whose prerequisite --
  npm, Terraform, Docker Desktop (with buildx), Git Bash, git, on Windows Windows PowerShell 5.1 -- is missing). arm64
  emulation is NOT required. The summary also states WINDOWS POWERSHELL 5.1: PROVEN / NOT PROVEN (13d; JSON
  windows_powershell_51): PROVEN only on Windows, from the three gs-host.ps1 gates' own 5.1 runs. The CERTIFYING run is
  the owner's on Windows -- OWNER SOURCE GATE PASS with 5.1 PROVEN (JSON certifying_run = true); a PASS where 5.1 cannot
  run says NOT A CERTIFYING RUN on its OVERALL line (exit 0 alone never means certified).
  Prerequisites: node + npm, git, Git Bash, Terraform >= 1.10, Docker Desktop running (Linux containers) with network
  access to public.ecr.aws, the npm registry and the Amazon Linux 2023 package repositories.
  It certifies the SOURCE only: the summary says OWNER SOURCE GATE PASS / FAIL and LIVE HOST CERTIFICATION PENDING -- the
  arm64 runtime smoke on the real Graviton host and the live AL2023 / systemd drills stay prerequisites of the cutover.

.PARAMETER Only
  Run only these gates (names as in the summary table, e.g. -Only Build,"COST-2C targeted"). The environment section
  always runs. Gates not selected are reported SKIPPED and the overall result is then never PASS.

.PARAMETER ListOnly
  Print the manifest (every command, in order) and the environment, run nothing, exit 0.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1
  (from a CLEAN clone: node_modules are installed by the Dependencies gate; Docker Desktop must be running)
.EXAMPLE
  pwsh -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1
#>
[CmdletBinding()]
param(
  [string[]]$Only = @(),
  [switch]$ListOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# `-File` passes "-Only a,b" as ONE string: split on commas either way.
$Only = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })

# ---------------------------------------------------------------------------------------------------------------------
# Where we are (works from any current directory; Windows PowerShell 5.1 and PowerShell 7+)
# ---------------------------------------------------------------------------------------------------------------------
$OnWindows = ($env:OS -eq 'Windows_NT')
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '../../..')).Path
if (-not (Test-Path (Join-Path $RepoRoot 'PROJECT_CANONICAL_CONTEXT.md'))) {
  Write-Host "RECON-1 OWNER GATE: cannot find the repository root above $ScriptDir" -ForegroundColor Red
  exit 2
}
$ServerDir = Join-Path $RepoRoot 'server'
$FrontendDir = Join-Path $RepoRoot 'frontend'
$Stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$GateDir = Join-Path (Join-Path $RepoRoot 'evidence') 'owner-gates'
if (-not $ListOnly) { New-Item -ItemType Directory -Force -Path $GateDir | Out-Null }
$LogPath = Join-Path $GateDir "recon1-owner-gate-$Stamp.log"
$JsonPath = Join-Path $GateDir "recon1-owner-gate-$Stamp.json"
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Writer = $null
$script:LastOutput = New-Object System.Collections.ArrayList
if (-not $ListOnly) { $script:Writer = New-Object System.IO.StreamWriter($LogPath, $true, $Utf8); $script:Writer.AutoFlush = $true }

function UtcNow { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Log([string]$Text, [string]$Color = '') {
  if ($Color -ne '') { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
  if ($null -ne $script:Writer) { $script:Writer.WriteLine($Text) }
}

function Find-Tool([string]$Name) {
  $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $c) { return $null }
  return $c.Source
}

# Git Bash (never WSL's System32\bash.exe): Git for Windows' bin\bash.exe; on Linux / macOS, bash on PATH.
function Find-Bash {
  if (-not $OnWindows) { return (Find-Tool 'bash') }
  $candidates = @()
  $git = Find-Tool 'git'
  if ($null -ne $git) { $candidates += (Join-Path (Split-Path -Parent (Split-Path -Parent $git)) 'bin\bash.exe') }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe') }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$Node = Find-Tool 'node'
$Npm = if ($OnWindows) { Find-Tool 'npm.cmd' } else { Find-Tool 'npm' }
$Git = Find-Tool 'git'
$Terraform = Find-Tool 'terraform'
$Docker = Find-Tool 'docker'
$Bash = Find-Bash

# RECON-1 owner-gate correction: the pinned Linux environments (index digests: each platform resolves its own manifest).
#   AL2023    the production OS, for the host scripts
#   NODE      the server image's own base (infra/docker/game-server.Dockerfile's NODE_IMAGE), for the Linux COST-2C run
#   DOCKERCLI the smoke runner (docker CLI on the host network with the Docker socket)
$Al2023Image = 'public.ecr.aws/amazonlinux/amazonlinux:2023@sha256:12052e9b5d3fd85769abbdd863dd038e1890c9ace31d5fdbe1afa78eda97d061'
$NodeLinuxImage = 'public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c'
$DockerCliImage = 'public.ecr.aws/docker/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c'
$script:Facts = [ordered]@{}
$script:DockerReady = $null

# Docker Desktop answering (once): $null when ready, otherwise why not.
function Docker-Problem {
  if ($null -eq $Docker) { return 'docker is not on PATH (Docker Desktop is required)' }
  if ($null -eq $script:DockerReady) {
    $code = Invoke-Logged $Docker @('version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}') $RepoRoot
    $script:DockerReady = if ($code -eq 0 -and (($script:LastOutput -join ' ') -match 'linux/')) { '' } else { 'the Docker daemon is not answering with Linux containers (start Docker Desktop, Linux containers mode)' }
  }
  if ($script:DockerReady -eq '') { return $null } else { return $script:DockerReady }
}

# A repository mount for `docker run -v`: read-only, the host path as Docker Desktop takes it.
$RepoMountRO = "${RepoRoot}:/repo:ro"

# The last "<n> passed, <m> failed" of a bash test harness (null when absent: the run did not finish).
function Harness-Counts([object[]]$Lines, [string]$Pattern) {
  $hit = $null
  foreach ($line in $Lines) { if ($line -match $Pattern) { $hit = @([int]$Matches[1], [int]$Matches[2]) } }
  return $hit
}

# OWNER-GATE FIX 1: the ELF machine of one file inside an image, WITHOUT running anything (docker create + docker cp: no
# emulation needed) -- 183 = AArch64, 62 = x86-64; $null when it cannot be read or is not a 64-bit little-endian ELF.
function Image-ElfMachine([string]$Image, [string]$Platform, [string]$PathInImage) {
  $code = Invoke-Logged $Docker @('create', '--platform', $Platform, $Image) $RepoRoot
  if ($code -ne 0) { return $null }
  $cid = [string]($script:LastOutput | Where-Object { $_ -match '^[0-9a-f]{64}$' } | Select-Object -Last 1)
  if ($cid -eq '') { return $null }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('recon1-elf-' + [guid]::NewGuid().ToString('N'))
  try {
    $code = Invoke-Logged $Docker @('cp', "${cid}:$PathInImage", $tmp) $RepoRoot
    if ($code -ne 0 -or -not (Test-Path $tmp)) { return $null }
    $h = New-Object byte[] 20
    $fs = [System.IO.File]::OpenRead($tmp)
    try { $n = $fs.Read($h, 0, 20) } finally { $fs.Dispose() }
    if ($n -ne 20 -or $h[0] -ne 0x7F -or $h[1] -ne 0x45 -or $h[2] -ne 0x4C -or $h[3] -ne 0x46 -or $h[4] -ne 2 -or $h[5] -ne 1) { return $null }
    return ([int]$h[18] + 256 * [int]$h[19])
  } finally {
    Invoke-Logged $Docker @('rm', '-f', $cid) $RepoRoot | Out-Null
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }
}

# OWNER-GATE FIX 1: an arm64 runtime check may be DEFERRED (never PASSED) only when the migration carries the mandatory,
# fail-closed live Graviton gate: the runbook's step 12b (gs-host arm64-smoke) BEFORE the edge cutover, and the cutover
# guard's refusal without its PASSING output.
function Live-Arm64-Gate-Present {
  $book = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'infra/aws/SINGLE_HOST_MIGRATION.md'))
  $guard = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'server/src/aws/deploy/migration/migrationCommands.ts'))
  return (($book -match '(?m)^12b\. ') -and ($book -match 'gs-host\.ps1 -Command arm64-smoke') -and ($book -match 'migration-guard edge-cutover [^\r\n]*--arm64-live-smoke') -and ($guard -match 'the edge cutover needs --arm64-live-smoke'))
}
$script:Arm64Runtime = 'NOT RUN'
$script:Arm64RuntimeDetail = 'the image gate did not reach the arm64 runtime check'
$ImageGateName = 'Image smoke (amd64 run; arm64 build + architecture)'
$Arm64RuntimeGateName = 'ARM64 runtime smoke'

# ---------------------------------------------------------------------------------------------------------------------
# Running one command: echoed first, stdout + stderr into the log AND the console, its exit code returned
# ---------------------------------------------------------------------------------------------------------------------
function Invoke-Logged {
  param([string]$Exe, [string[]]$Arguments, [string]$Cwd, [hashtable]$Environment = @{})
  $shown = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  Log ("  [{0}] > (in {1}) {2} {3}" -f (UtcNow), $Cwd, $Exe, $shown) 'Cyan'
  $saved = @{}
  foreach ($k in $Environment.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    [Environment]::SetEnvironmentVariable($k, [string]$Environment[$k])
    Log ("    env {0}={1}" -f $k, $Environment[$k])
  }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $Cwd
  try {
    $script:LastOutput = New-Object System.Collections.ArrayList
    & $Exe @Arguments 2>&1 | ForEach-Object { $line = [string]$_; [void]$script:LastOutput.Add($line); Log $line }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
  } catch {
    Log ("    the command could not be run: {0}" -f $_.Exception.Message) 'Red'
    $code = 9009
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  Log ("    exit {0}" -f $code)
  return [int]$code
}

# ---------------------------------------------------------------------------------------------------------------------
# The manifest (derived from server/package.json's scripts and infra/aws/README.md's Terraform procedure)
# ---------------------------------------------------------------------------------------------------------------------
$Dist = 'dist/server/src'
$NodeTest = @('--test', '--test-concurrency=1', '--test-reporter=tap')
function TestArgs([string[]]$Files) { return ($NodeTest + ($Files | ForEach-Object { "$Dist/$_" })) }

$Gates = New-Object System.Collections.ArrayList
function Add-Gate([string]$Name, [bool]$NeedsBuild, [scriptblock]$Body, [string]$Describe, [bool]$NeedsDeps = $false) {
  [void]$Gates.Add([pscustomobject]@{ Name = $Name; NeedsBuild = $NeedsBuild; NeedsDeps = ($NeedsDeps -or $NeedsBuild); Body = $Body; Describe = $Describe; Status = 'SKIPPED'; Exit = $null; Seconds = 0.0; Reason = ''; Started = ''; Ended = '' })
}

Add-Gate 'Windows LF checkout' $false {
  if ($null -eq $Git) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'git is not on PATH (the W-04 checkout cannot be judged)' } }
  $code = Invoke-Logged $Git @('ls-files', '--eol', '--', 'infra/aws/modules/single-host', 'infra/aws/single-host') $RepoRoot
  if ($code -ne 0) { return @{ Exit = $code } }
  $pinned = 0; $bad = @()
  foreach ($line in $script:LastOutput) {
    if ($line -match '^i/(\S+)\s+w/(\S*)\s+attr/(\S.*?)\s*\t(.+)$') {
      $wt = $Matches[2]; $attr = $Matches[3]; $file = $Matches[4]
      if ($attr -match 'eol=lf') { $pinned++; if ($wt -ne 'lf') { $bad += "$file (w/$wt)" } }
    }
  }
  if ($pinned -lt 25) { return @{ Status = 'FAIL'; Exit = $code; Reason = "only $pinned eol=lf single-host files found (is .gitattributes the RECON-1A one?)" } }
  if ($bad.Count -gt 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = "CRLF in the working tree of eol=lf files: $($bad -join ', ') -- re-clone, or: git rm -r -q --cached infra/aws/modules/single-host; git reset -q --hard" } }
  Log "    $pinned eol=lf single-host files, every one LF in the working tree"
  return @{ Exit = 0 }
} 'git ls-files --eol -- infra/aws/modules/single-host infra/aws/single-host   (every eol=lf file must be w/lf)'

Add-Gate 'Dependencies (npm ci)' $false {
  if ($null -eq $Node -or $null -eq $Npm) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'node / npm is not on PATH' } }
  if ($null -eq $Git) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'git is not on PATH (the tree cannot be proven unchanged by npm ci)' } }
  $locks = @('frontend/package-lock.json', 'server/package-lock.json')
  foreach ($l in $locks) { if (-not (Test-Path (Join-Path $RepoRoot $l))) { return @{ Status = 'FAIL'; Exit = $null; Reason = "$l is missing: no locked install is possible" } } }
  $hash = { param($rel) (Get-FileHash -Algorithm SHA256 -Path (Join-Path $RepoRoot $rel)).Hash.ToLowerInvariant() }
  $lockBefore = @{}; foreach ($l in $locks) { $lockBefore[$l] = & $hash $l }
  $code = Invoke-Logged $Git @('status', '--porcelain', '--untracked-files=all') $RepoRoot
  if ($code -ne 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'git status failed' } }
  $treeBefore = @($script:LastOutput | Where-Object { $_ -ne '' })
  foreach ($d in @('frontend', 'server')) {
    $c = Invoke-Logged $Npm @('ci', '--ignore-scripts', '--no-audit', '--no-fund') (Join-Path $RepoRoot $d)
    if ($c -ne 0) { return @{ Status = 'FAIL'; Exit = $c; Reason = "npm ci failed in $d\ (no stale dependency is used: every later gate is BLOCKED)" } }
  }
  $changedLocks = @($locks | Where-Object { (& $hash $_) -ne $lockBefore[$_] })
  if ($changedLocks.Count -gt 0) { return @{ Status = 'FAIL'; Exit = 0; Reason = "npm ci CHANGED $($changedLocks -join ', ')" } }
  $code = Invoke-Logged $Git @('status', '--porcelain', '--untracked-files=all') $RepoRoot
  if ($code -ne 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'git status failed after npm ci' } }
  $treeAfter = @($script:LastOutput | Where-Object { $_ -ne '' })
  $new = @($treeAfter | Where-Object { $treeBefore -notcontains $_ })
  if ($new.Count -gt 0) { return @{ Status = 'FAIL'; Exit = 0; Reason = "npm ci changed tracked / unignored files: $($new -join '; ')" } }
  foreach ($need in @('frontend/node_modules/typescript/bin/tsc', 'server/node_modules/@aws-sdk/client-dynamodb')) {
    if (-not (Test-Path (Join-Path $RepoRoot $need))) { return @{ Status = 'FAIL'; Exit = 0; Reason = "$need is absent after npm ci" } }
  }
  $script:Facts['package_locks_sha256'] = $lockBefore
  Log '    both lock files unchanged; the tracked tree unchanged by npm ci (node_modules is ignored)'
  return @{ Exit = 0 }
} 'npm ci --ignore-scripts --no-audit --no-fund in frontend\ and server\ (locked; the tree and both package-lock files must be unchanged after)'

Add-Gate 'Build' $false {
  if ($null -eq $Node) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'node is not on PATH' } }
  $tsc = Join-Path $FrontendDir 'node_modules/typescript/bin/tsc'
  if (-not (Test-Path $tsc)) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'frontend\node_modules\typescript is missing (npm ci in frontend\ first)' } }
  if (-not (Test-Path (Join-Path $ServerDir 'node_modules/@aws-sdk/client-dynamodb'))) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'server\node_modules is missing (npm ci in server\ first)' } }
  $code = Invoke-Logged $Node @('../frontend/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json') $ServerDir
  return @{ Exit = $code }
} 'node ../frontend/node_modules/typescript/bin/tsc -p tsconfig.json   (server; = npm run build)' $true

Add-Gate 'RECON-1 authorization gates' $true {
  $code = Invoke-Logged $Node (TestArgs @('aws/deploy/migration/recon1AuthorizationGates.test.js', 'aws/deploy/migration/recon1SevenATargets.test.js')) $ServerDir
  $skippedPs = @($script:LastOutput | Where-Object { $_ -match 'plan-evidence\.ps1' -and $_ -match '# SKIP' })
  if ($code -eq 0 -and $OnWindows -and $skippedPs.Count -gt 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = "plan-evidence.ps1's test was SKIPPED (no Windows PowerShell / pwsh found): the Windows capture path was NOT RUN" } }
  return @{ Exit = $code }
} 'node --test deploy/migration/recon1AuthorizationGates + recon1SevenATargets   (on Windows its plan-evidence.ps1 test must run)'

Add-Gate 'COST-2B migration guards' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('aws/deploy/migration/cost2bMigrationGuards.test.js')) $ServerDir) }
} 'node --test deploy/migration/cost2bMigrationGuards'

Add-Gate 'COST-2C targeted' $true {
  $envs = @{}
  if ($null -ne $Bash) { $envs['GS_TEST_BASH'] = $Bash }
  $code = Invoke-Logged $Node (TestArgs @('aws/deploy/hostcert/hostCert.test.js')) $ServerDir $envs
  $n = -1
  foreach ($line in $script:LastOutput) { if ($line -match '^# skipped (\d+)') { $n = [int]$Matches[1] } }
  if ($code -eq 0 -and $n -ne 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = "$n COST-2C test(s) SKIPPED (Git Bash not found: the templates / gs-exit-hold parity were NOT RUN)" } }
  return @{ Exit = $code }
} 'node --test aws/deploy/hostcert/hostCert.test.js   (GS_TEST_BASH = Git Bash; any skip FAILS the gate)'

Add-Gate 'COST-2C targeted (Linux)' $true {
  $why = Docker-Problem
  if ($null -ne $why) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = $why } }
  $name = "recon1-owner-gate-cost2c-$Stamp".ToLower()
  $cmd = 'command -v bash >/dev/null && command -v sha256sum >/dev/null && command -v base64 >/dev/null && command -v timeout >/dev/null || exit 98; exec node --test --test-concurrency=1 --test-reporter=tap dist/server/src/aws/deploy/hostcert/hostCert.test.js'
  try {
    $code = Invoke-Logged $Docker @('run', '--rm', '--name', $name, '--network', 'none', '-v', $RepoMountRO, '-w', '/repo/server', $NodeLinuxImage, 'bash', '-c', $cmd) $RepoRoot
    $out = @($script:LastOutput)   # kept BEFORE the cleanup command replaces the last output
  } finally {
    Invoke-Logged $Docker @('rm', '-f', $name) $RepoRoot | Out-Null
  }
  if ($code -eq 98) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'READINESS: the Linux image lacks bash / sha256sum / base64 / timeout' } }
  $n = -1; $p = -1
  foreach ($line in $out) { if ($line -match '^# skipped (\d+)') { $n = [int]$Matches[1] }; if ($line -match '^# pass (\d+)') { $p = [int]$Matches[1] } }
  if ($code -eq 0 -and ($n -ne 0 -or $p -le 0)) { return @{ Status = 'FAIL'; Exit = $code; Reason = "the Linux run reported pass=$p skipped=$n (every test must run)" } }
  return @{ Exit = $code }
} 'docker run --rm --network none -v <repo>:/repo:ro <node:22-bookworm-slim@sha256 (the server image base)> node --test hostcert/hostCert.test.js   (Linux bash; any skip FAILS)'

Add-Gate 'COST-2A verifier/snapshot' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('aws/deploy/cost2aHostVerifier.test.js', 'aws/operator/cost2aHostSnapshot.test.js')) $ServerDir) }
} 'node --test deploy/cost2aHostVerifier, operator/cost2aHostSnapshot'

Add-Gate 'JX-4C / P5 cross-slice' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('aws/operator/jx4cOperatorEvidenceIam.test.js', 'aws/runtime/p5IntCrossSlice.test.js')) $ServerDir) }
} 'node --test operator/jx4cOperatorEvidenceIam, runtime/p5IntCrossSlice'

Add-Gate 'Ownership/fencing regression' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('rooms/l5_3Ownership.test.js', 'persistence/conformance/fenceGap.test.js', 'aws/awsClients.test.js', 'persistence/conformance/l6_5bAlarms.test.js')) $ServerDir) }
} 'node --test rooms/l5_3Ownership, conformance/fenceGap, aws/awsClients, conformance/l6_5bAlarms'

Add-Gate 'awsDeploy/stage-cert regression' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('aws/deploy/l5_8Deploy.test.js', 'aws/deploy/staging/l6_6StagingCert.test.js', 'aws/deploy/staging/rotationProof.test.js', 'aws/deploy/staging/restoreFencing.test.js')) $ServerDir) }
} 'node --test deploy/l5_8Deploy, staging/l6_6StagingCert, staging/rotationProof, staging/restoreFencing'

Add-Gate 'COST-1 guards + portability' $true {
  return @{ Exit = (Invoke-Logged $Node (TestArgs @('aws/deploy/cost1SingleHost.test.js', 'aws/runtime/singleHostMetrics.test.js')) $ServerDir) }
} 'node --test deploy/cost1SingleHost, runtime/singleHostMetrics'

# PHASE 1 CERTIFICATION CLOSURE: the Phase-1 suites as named gates (cheap and static; the full suite runs them again).
# Their pins diff against the host-create commit 5b4756d and the stderr hotfix 083d066: a clone without either (a shallow
# one) would SKIP or silently pass them, so both must be in this clone, and a SKIP of 13r's host-create pins FAILS too.
Add-Gate 'PHASE-1 targeted' $true {
  if ($null -eq $Git) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'git is not on PATH (the Phase-1 pins diff against their base commits)' } }
  foreach ($base in @('5b4756dbd98e8d9abe5ed4bbdf4314466ef8045d', '083d0668556c05a84eb8b3e5befc4e973544aa9a')) {
    $c = Invoke-Logged $Git @('cat-file', '-e', ($base + '^{commit}')) $RepoRoot
    if ($c -ne 0) { return @{ Status = 'FAIL'; Exit = $c; Reason = "git cannot show commit $base here (a shallow or partial clone, or git refused the repository): the Phase-1 pins diff against it -- use a full clone" } }
  }
  $code = Invoke-Logged $Node (TestArgs @('aws/deploy/migration/phase1FreshHost.test.js', 'aws/deploy/migration/phase1RemainderRunbook.test.js', 'aws/deploy/migration/step9AcmeCompletion.test.js', 'aws/deploy/staging/singleHostEdge.test.js', 'aws/deploy/staging/hostRoleProbe.test.js')) $ServerDir
  $skippedPins = @($script:LastOutput | Where-Object { $_ -match '# SKIP not a checkout holding the host-create commit' })
  if ($code -eq 0 -and $skippedPins.Count -gt 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = "13r's host-create pins were SKIPPED (this clone lacks commit 5b4756d -- a shallow clone?): clone the full history" } }
  return @{ Exit = $code }
} 'node --test migration/phase1FreshHost (13r; its host-create pins must RUN), phase1RemainderRunbook, step9AcmeCompletion, staging/singleHostEdge (step 16), staging/hostRoleProbe (F5 / F6)'

# PHASE 1 CERTIFICATION CLOSURE: F5 / F6's REAL host-role-probe.sh (with the real gs-lib.sh) on a fake host runs only on
# Linux (flock, sha256sum, fold, awk) -- hostRoleProbe SKIPS it on Windows -- so it runs here, in the server image's own
# pinned base, with no network and the repository read-only; every test must run.
Add-Gate 'PHASE-1 targeted (Linux)' $true {
  $why = Docker-Problem
  if ($null -ne $why) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = $why } }
  $name = "recon1-owner-gate-phase1-$Stamp".ToLower()
  # No double quote anywhere in $cmd (Windows PowerShell 5.1 passes native arguments verbatim only without them).
  $cmd = 'for c in bash flock sha256sum fold awk base64 mktemp timeout; do command -v $c >/dev/null || exit 98; done; exec node --test --test-concurrency=1 --test-reporter=tap dist/server/src/aws/deploy/staging/hostRoleProbe.test.js'
  try {
    $code = Invoke-Logged $Docker @('run', '--rm', '--name', $name, '--network', 'none', '-v', $RepoMountRO, '-w', '/repo/server', $NodeLinuxImage, 'bash', '-c', $cmd) $RepoRoot
    $out = @($script:LastOutput)   # kept BEFORE the cleanup command replaces the last output
  } finally {
    Invoke-Logged $Docker @('rm', '-f', $name) $RepoRoot | Out-Null
  }
  if ($code -eq 98) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'READINESS: the Linux image lacks bash / flock / sha256sum / fold / awk / base64 / mktemp / timeout' } }
  $n = -1; $p = -1
  foreach ($line in $out) { if ($line -match '^# skipped (\d+)') { $n = [int]$Matches[1] }; if ($line -match '^# pass (\d+)') { $p = [int]$Matches[1] } }
  $script:Facts['phase1_linux'] = [ordered]@{ image = $NodeLinuxImage; suite = 'staging/hostRoleProbe'; passed = $p; skipped = $n }
  if ($code -eq 0 -and ($n -ne 0 -or $p -lt 20)) { return @{ Status = 'FAIL'; Exit = $code; Reason = "the Linux run reported pass=$p skipped=$n (>= 20 passed and no skip required: the real wrapper on a fake host)" } }
  return @{ Exit = $code }
} 'docker run --rm --network none -v <repo>:/repo:ro <node:22-bookworm-slim@sha256 (the server image base)> node --test staging/hostRoleProbe.test.js   (F5 / F6: the REAL host-role-probe.sh on a fake host -- Linux only; any skip FAILS)'

# PHASE 1 CERTIFICATION CLOSURE: gs-host.ps1's three offline regressions (infra/aws/single-host/tests), each its own gate,
# each run with its header's documented command -- -NoProfile -ExecutionPolicy Bypass -File <test>, NO -Target, so the
# test resolves the candidate's own gs-host.ps1 itself; this gate adds only -NonInteractive and, on Windows, Windows
# PowerShell's own module path -- in a child process (their fakes shadow aws.exe globally). On Windows the engine is
# WINDOWS POWERSHELL 5.1, System32's powershell.exe (the engine the runbook runs gs-host.ps1 with), whichever PowerShell
# runs this gate, and the test's OWN header must say so; elsewhere it is this PowerShell, and nothing calls that a Windows
# PowerShell 5.1 proof.
$GsHostPsGateNames = @('gs-host.ps1 stderr regression', 'gs-host.ps1 role-probe regression', 'gs-host.ps1 install-script regression')
$script:Facts['gs_host_powershell'] = [ordered]@{}
function Find-WindowsPowerShell51 {
  $root = if ($env:SystemRoot) { $env:SystemRoot } else { $env:windir }
  if ([string]::IsNullOrEmpty($root)) { return $null }
  $exe = Join-Path $root 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
  return $null
}
function Invoke-GsHostPsRegression([string]$Test, [int]$Floor) {
  $file = Join-Path $RepoRoot "infra/aws/single-host/tests/gs-host-$Test.test.ps1"
  $gsHost = Join-Path $RepoRoot 'infra/aws/single-host/gs-host.ps1'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or -not (Test-Path -LiteralPath $gsHost -PathType Leaf)) { return @{ Status = 'FAIL'; Exit = $null; Reason = "gs-host-$Test.test.ps1 or gs-host.ps1 is missing" } }
  $file = (Resolve-Path -LiteralPath $file).Path
  $want = (Resolve-Path -LiteralPath $gsHost).Path
  $envs = @{}
  if ($OnWindows) {
    $exe = Find-WindowsPowerShell51
    if ($null -eq $exe) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'Windows PowerShell 5.1 (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe) was not found: this regression is REQUIRED under it on Windows' } }
    $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $file)
    # The child gets Windows PowerShell's own module path, whichever PowerShell runs this gate.
    $modules = @()
    if ($env:ProgramFiles) { $modules += (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules') }
    $modules += (Join-Path (Split-Path -Parent $exe) 'Modules')
    $envs['PSModulePath'] = ($modules -join ';')
  } else {
    $exe = (Get-Process -Id $PID).Path
    $argv = @('-NoProfile', '-NonInteractive', '-File', $file)
  }
  $code = Invoke-Logged $exe $argv $RepoRoot $envs
  $out = @($script:LastOutput)
  $head = $null
  foreach ($line in $out) { if ($line -match ('^gs-host ' + [regex]::Escape($Test) + ' regression -- PowerShell (\S+) \((\w+)\) -- (.+)$')) { $head = @($Matches[1], $Matches[2], $Matches[3]) } }
  $counts = Harness-Counts $out ('^gs-host ' + [regex]::Escape($Test) + ' regression: (\d+) passed / (\d+) failed$')
  $engine = if ($null -eq $head) { 'an unknown PowerShell (no header)' } elseif ($head[1] -eq 'Desktop') { "Windows PowerShell $($head[0]) (Desktop)" } else { "PowerShell $($head[0]) ($($head[1]))" }
  $script:Facts['gs_host_powershell'][$Test] = [ordered]@{ engine = $engine; executable = $exe; target = $(if ($null -eq $head) { $null } else { $head[2] }); passed = $(if ($null -eq $counts) { $null } else { $counts[0] }); failed = $(if ($null -eq $counts) { $null } else { $counts[1] }); floor = $Floor; exit = $code }
  if ($null -eq $head) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'the test printed no header: it stopped before its first case (the 5.1 -Target default did exactly that)' } }
  if ($OnWindows -and ($head[0] -notmatch '^5\.1\.' -or $head[1] -ne 'Desktop')) { return @{ Status = 'FAIL'; Exit = $code; Reason = "it ran under $engine, not Windows PowerShell 5.1 (Desktop)" } }
  $sameTarget = if ($OnWindows) { $head[2] -eq $want } else { $head[2] -ceq $want }
  if (-not $sameTarget) { return @{ Status = 'FAIL'; Exit = $code; Reason = "it tested $($head[2]), not the candidate's $want" } }
  if ($null -eq $counts) { return @{ Status = 'FAIL'; Exit = $code; Reason = "$engine`: the test did not report its totals (it did not finish)" } }
  if ($code -ne 0 -or $counts[1] -ne 0 -or $counts[0] -lt $Floor) { return @{ Status = 'FAIL'; Exit = $code; Reason = "$engine`: $($counts[0]) passed / $($counts[1]) failed, exit $code (>= $Floor passed, 0 failed, exit 0 required)" } }
  $proof = if ($OnWindows) { 'the Windows PowerShell 5.1 proof' } else { 'NOT a Windows PowerShell 5.1 proof (not Windows)' }
  return @{ Exit = 0; Reason = "$engine`: $($counts[0]) passed / 0 failed, as documented (no -Target) on the candidate's gs-host.ps1 -- $proof" }
}
$GsHostPsDescribe = 'Windows: System32 powershell.exe (5.1) -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <test>, NO -Target (its header must say 5.1 / Desktop and the candidate''s gs-host.ps1); elsewhere this pwsh, NOT a 5.1 proof'
Add-Gate 'gs-host.ps1 stderr regression' $false { return (Invoke-GsHostPsRegression 'stderr' 25) } "tests/gs-host-stderr.test.ps1 (>= 25 passed, 0 failed)   $GsHostPsDescribe"
Add-Gate 'gs-host.ps1 role-probe regression' $false { return (Invoke-GsHostPsRegression 'role-probe' 38) } "tests/gs-host-role-probe.test.ps1 (>= 38 passed, 0 failed)   $GsHostPsDescribe"
Add-Gate 'gs-host.ps1 install-script regression' $false { return (Invoke-GsHostPsRegression 'install-script' 27) } "tests/gs-host-install-script.test.ps1 (>= 27 passed, 0 failed)   $GsHostPsDescribe"

Add-Gate 'Terraform' $false {
  if ($null -eq $Terraform) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'terraform is not on PATH (Terraform >= 1.10 is required)' } }
  $worst = 0
  $aws = Join-Path (Join-Path $RepoRoot 'infra') 'aws'
  $c = Invoke-Logged $Terraform @('fmt', '-check', '-recursive') $aws; if ($c -ne 0) { $worst = $c }
  foreach ($m in @('modules/single-host', 'modules/app', 'modules/ledger')) {
    $dir = Join-Path $aws $m
    $c = Invoke-Logged $Terraform @('init', '-backend=false', '-input=false') $dir; if ($c -ne 0) { $worst = $c; continue }
    $c = Invoke-Logged $Terraform @('test') $dir; if ($c -ne 0) { $worst = $c }
  }
  foreach ($s in @('stacks/single-host', 'stacks/app', 'stacks/ledger')) {
    $dir = Join-Path $aws $s
    $c = Invoke-Logged $Terraform @('init', '-backend=false', '-input=false') $dir; if ($c -ne 0) { $worst = $c; continue }
    $c = Invoke-Logged $Terraform @('validate') $dir; if ($c -ne 0) { $worst = $c }
  }
  return @{ Exit = $worst }
} 'terraform fmt -check -recursive (infra/aws); init -backend=false + test (modules single-host, app, ledger); init -backend=false + validate (stacks single-host, app, ledger)'

Add-Gate 'Single-host scripts' $false {
  $why = Docker-Problem
  if ($null -ne $why) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = "$why -- the host scripts run only in a genuine Linux (Amazon Linux 2023) userspace" } }
  $name = "recon1-owner-gate-hostscripts-$Stamp".ToLower()
  # No double quote anywhere in $cmd (Windows PowerShell 5.1 passes native arguments verbatim only without them).
  # The module AND the operator's single-host tooling, in their repository layout (the suite also runs 13r's reviewed
  # host-script-install.sh and gs-host.sh install-script end to end, from infra/aws/single-host).
  $cmd = 'dnf -y -q install util-linux-core findutils >/dev/null 2>&1 || exit 97; for c in bash flock python3 find sha256sum timeout awk cut tr date mktemp stat; do command -v $c >/dev/null || exit 98; done; mkdir -p /work/aws/modules && cp -r /repo/infra/aws/modules/single-host /work/aws/modules/single-host && cp -r /repo/infra/aws/single-host /work/aws/single-host && chmod 0755 /work/aws/modules/single-host/files/bin/* || exit 99; exec bash /work/aws/modules/single-host/tests/host-scripts.test.sh'
  try {
    $code = Invoke-Logged $Docker @('run', '--rm', '--name', $name, '-v', $RepoMountRO, $Al2023Image, 'bash', '-c', $cmd) $RepoRoot
    $out = @($script:LastOutput)   # kept BEFORE the cleanup command replaces the last output
  } finally {
    Invoke-Logged $Docker @('rm', '-f', $name) $RepoRoot | Out-Null
  }
  if ($code -eq 97) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'READINESS: dnf could not install util-linux-core / findutils in the AL2023 container (network to the Amazon Linux repositories?)' } }
  if ($code -eq 98 -or $code -eq 99) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'READINESS: the AL2023 test userspace could not be prepared (a required command or the module copy is missing)' } }
  $counts = Harness-Counts $out '^(\d+) passed, (\d+) failed$'
  if ($null -eq $counts) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'the suite did not report its totals (it did not finish)' } }
  $script:Facts['host_scripts'] = [ordered]@{ image = $Al2023Image; passed = $counts[0]; failed = $counts[1] }
  if ($code -eq 0 -and ($counts[1] -ne 0 -or $counts[0] -lt 83)) { return @{ Status = 'FAIL'; Exit = $code; Reason = "totals $($counts[0]) passed / $($counts[1]) failed (>= 83 passed, 0 failed required)" } }
  return @{ Exit = $code }
} 'docker run --rm -v <repo>:/repo:ro <amazonlinux:2023@sha256> : dnf util-linux-core findutils; bash host-scripts.test.sh on a 0755 copy of the module (+ infra/aws/single-host for 13r)   (genuine AL2023 userspace; offline stubs)'

# PHASE 1 FRESH-HOST HARDENING: the one-server check against a REAL daemon and AL2023's OWN docker CLI (the stub that let
# step 13's fresh-host failure pass every offline gate is not in this path). The suite exits 2 (NOT RUN) on its own
# refusals: no daemon, the image absent, or a gs-server container already present (it never touches one it did not make).
Add-Gate 'Single-host real Docker' $false {
  $why = Docker-Problem
  if ($null -ne $why) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = "$why -- the real-Docker regression runs against the Docker daemon" } }
  $name = "recon1-owner-gate-realdocker-$Stamp".ToLower()
  # No double quote anywhere in $cmd (Windows PowerShell 5.1 passes native arguments verbatim only without them).
  $cmd = 'dnf -y -q install docker util-linux-core findutils >/dev/null 2>&1 || exit 97; for c in bash docker flock curl grep mktemp; do command -v $c >/dev/null || exit 98; done; mkdir -p /work && cp -r /repo/infra/aws/modules/single-host /work/single-host && chmod 0755 /work/single-host/files/bin/* || exit 99; docker --version; exec bash /work/single-host/tests/preflight-real-docker.test.sh ' + $Al2023Image
  try {
    $code = Invoke-Logged $Docker @('run', '--rm', '--name', $name, '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', $RepoMountRO, $Al2023Image, 'bash', '-c', $cmd) $RepoRoot
    $out = @($script:LastOutput)   # kept BEFORE the cleanup command replaces the last output
  } finally {
    Invoke-Logged $Docker @('rm', '-f', $name) $RepoRoot | Out-Null
  }
  if ($code -eq 97) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'READINESS: dnf could not install docker / util-linux-core / findutils in the AL2023 container (network to the Amazon Linux repositories?)' } }
  if ($code -eq 98 -or $code -eq 99) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'READINESS: the AL2023 test userspace could not be prepared (a required command or the module copy is missing)' } }
  if ($code -eq 2) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = "the suite refused to run: $([string]($out | Where-Object { $_ -match '^NOT RUN' } | Select-Object -Last 1))" } }
  $counts = Harness-Counts $out '^(\d+) passed, (\d+) failed \(docker CLI'
  if ($null -eq $counts) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'the suite did not report its totals (it did not finish)' } }
  $script:Facts['host_real_docker'] = [ordered]@{ image = $Al2023Image; cli = [string]($out | Where-Object { $_ -match '^Docker version ' } | Select-Object -First 1); passed = $counts[0]; failed = $counts[1] }
  if ($code -eq 0 -and ($counts[1] -ne 0 -or $counts[0] -lt 25)) { return @{ Status = 'FAIL'; Exit = $code; Reason = "totals $($counts[0]) passed / $($counts[1]) failed (>= 25 passed, 0 failed required)" } }
  return @{ Exit = $code }
} 'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v <repo>:/repo:ro <amazonlinux:2023@sha256> : dnf docker (AL2023 CLI) util-linux-core findutils; bash preflight-real-docker.test.sh against the REAL daemon (gs-server / gs-rt-* containers, removed after)'

# OWNER-GATE FIX 1: the image gate is the SOURCE proof. linux/amd64: build + metadata + the full runtime smoke (required).
# linux/arm64: the BUILD (the Dockerfile's build stage runs on the builder's platform and the runtime stage only COPIES, so
# no emulation is needed) + the ARCHITECTURE PROOF without executing anything -- image metadata linux/arm64 AND the image's
# own node binary an AArch64 ELF (docker create + docker cp) -- with the architecture-neutral dependency guard inside the
# build (check-arch-neutral.cjs). The arm64 EXECUTION is the next gate's: run here only when this machine can (emulation),
# otherwise DEFERRED to the required live Graviton gate -- never PASS, never inferred from amd64.
Add-Gate $ImageGateName $false {
  $why = Docker-Problem
  if ($null -ne $why) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = $why } }
  $code = Invoke-Logged $Docker @('buildx', 'version') $RepoRoot
  if ($code -ne 0) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'docker buildx is not available (Docker Desktop ships it)' } }
  $results = [ordered]@{}
  $problems = @()
  $tags = @()
  $script:Arm64Runtime = 'NOT RUN'; $script:Arm64RuntimeDetail = 'the arm64 build / architecture proof did not complete'
  try {
    foreach ($platform in @('linux/amd64', 'linux/arm64')) {
      $arch = $platform.Substring(6)
      $tag = ("recon1-owner-gate-smoke:$Stamp-$arch").ToLower()
      $tags += $tag
      $buildArgs = @('buildx', 'build', '--platform', $platform, '-f', 'infra/docker/game-server.Dockerfile', '--label', "org.opencontainers.image.revision=$Head", '--provenance=false', '--load', '-t', $tag)
      if (-not [string]::IsNullOrEmpty($env:BUILD_CA)) { $buildArgs += @('--secret', "id=build_ca,src=$($env:BUILD_CA)") }
      $buildArgs += '.'
      $c = Invoke-Logged $Docker $buildArgs $RepoRoot
      if ($c -ne 0) { $problems += "$platform BUILD FAILED (exit $c)"; $results["$platform build"] = "FAILED (exit $c)"; continue }
      # the architecture proof, without running the image
      $c = Invoke-Logged $Docker @('image', 'inspect', '-f', '{{.Os}}/{{.Architecture}} {{.Id}}', $tag) $RepoRoot
      $meta = [string]($script:LastOutput | Select-Object -Last 1)
      if ($c -ne 0 -or -not $meta.StartsWith("$platform ")) { $problems += "$platform ARCHITECTURE PROOF FAILED (image metadata '$meta')"; $results["$platform build"] = "PASS; architecture proof FAILED ($meta)"; continue }
      $wantMachine = if ($arch -eq 'amd64') { 62 } else { 183 }
      $machine = Image-ElfMachine $tag $platform '/usr/local/bin/node'
      if ($machine -ne $wantMachine) { $problems += "$platform ARCHITECTURE PROOF FAILED (the image's node is ELF machine $machine, not $wantMachine)"; $results["$platform build"] = "PASS; architecture proof FAILED (node ELF machine $machine)"; continue }
      $results["$platform build"] = "PASS; architecture proof PASS (image $($meta.Split(' ')[0]), $($meta.Split(' ')[1]); node ELF machine $machine)"
      # Can this platform's containers RUN here (arm64 on x86 needs Docker Desktop's QEMU / binfmt)?
      $c = Invoke-Logged $Docker @('run', '--rm', '--platform', $platform, '--network', 'none', '--entrypoint', 'node', $NodeLinuxImage, '-p', 'process.arch') $RepoRoot
      $want = if ($arch -eq 'amd64') { 'x64' } else { 'arm64' }
      $probeText = ($script:LastOutput -join ' ')
      $runnable = ($c -eq 0 -and ($probeText -match "\b$want\b"))
      if (-not $runnable) {
        $probeLast = [string]($script:LastOutput | Select-Object -Last 1)
        if ($arch -eq 'amd64') { $problems += "linux/amd64 cannot run here (probe exit $c`: $probeLast): the REQUIRED amd64 runtime smoke was NOT RUN"; $results['linux/amd64 runtime'] = 'NOT RUN' }
        elseif ($probeText -match 'exec format error') { $script:Arm64Runtime = 'DEFERRED'; $script:Arm64RuntimeDetail = 'linux/arm64 cannot execute on this machine (exec format error: no emulation): the runtime smoke belongs to the REQUIRED live Graviton gate'; $results['linux/arm64 runtime'] = 'DEFERRED TO REQUIRED LIVE GRAVITON GATE (exec format error: no emulation)' }
        else { $script:Arm64Runtime = 'NOT RUN'; $script:Arm64RuntimeDetail = "the linux/arm64 runnable probe failed for another reason (exit $c`: $probeLast) -- not 'no emulation', so nothing is deferred"; $results['linux/arm64 runtime'] = "NOT RUN (probe exit $c)" }
        continue
      }
      $runner = ("recon1-owner-gate-smoke-runner-$Stamp-$arch").ToLower()
      $cmd = 'apk add --no-cache -q bash curl coreutils >/dev/null 2>&1 || exit 97; exec bash /repo/infra/aws/modules/single-host/tests/image-smoke.sh ' + $tag + ' ' + $platform
      try {
        $c = Invoke-Logged $Docker @('run', '--rm', '--name', $runner, '--network', 'host', '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', $RepoMountRO, $DockerCliImage, 'sh', '-c', $cmd) $RepoRoot
        $out = @($script:LastOutput)   # kept BEFORE the cleanup command replaces the last output
      } finally {
        Invoke-Logged $Docker @('rm', '-f', $runner, "gs-smoke-$arch") $RepoRoot | Out-Null
      }
      $counts = Harness-Counts $out ('^\[' + [regex]::Escape($platform) + '\] (\d+) passed, (\d+) failed$')
      $verdict = if ($c -eq 97) { 'NOT RUN (the smoke runner could not install bash / curl)' } elseif ($null -eq $counts) { "FAIL (no totals, exit $c)" } elseif ($c -ne 0 -or $counts[1] -ne 0 -or $counts[0] -lt 7) { "FAIL ($($counts[0]) passed, $($counts[1]) failed, exit $c)" } else { "PASS ($($counts[0]) passed, 0 failed)" }
      $results["$platform runtime"] = $verdict
      if ($arch -eq 'amd64') { if (-not $verdict.StartsWith('PASS')) { $problems += "linux/amd64 runtime smoke $verdict" } }
      else { $script:Arm64Runtime = if ($verdict.StartsWith('PASS')) { 'PASS' } elseif ($verdict.StartsWith('FAIL')) { 'FAIL' } else { 'NOT RUN' }; $script:Arm64RuntimeDetail = "linux/arm64 runtime smoke (emulated here): $verdict" }
    }
  } finally {
    foreach ($t in $tags) { Invoke-Logged $Docker @('image', 'rm', '-f', $t) $RepoRoot | Out-Null }
  }
  $script:Facts['image_smoke'] = $results
  if ($problems.Count -gt 0) { return @{ Status = 'FAIL'; Exit = 1; Reason = ($problems -join '; ') } }
  return @{ Exit = 0 }
} 'docker buildx build --load (LOCAL tags; no push, no ECR login) of game-server.Dockerfile for linux/amd64 and linux/arm64; image metadata + the node ELF machine of each (docker create/cp: no execution); image-smoke.sh for amd64 (REQUIRED) from a pinned docker-cli runner (host network + Docker socket); images removed after'

# OWNER-GATE FIX 1: the arm64 EXECUTION proof. PASS only if this machine really executed the arm64 smoke; DEFERRED (not
# PASS) only when the arm64 BUILD + ARCHITECTURE proof and the amd64 runtime smoke passed AND the migration carries the
# mandatory live Graviton gate (step 12b before the edge cutover; the cutover guard refuses without its PASS).
Add-Gate $Arm64RuntimeGateName $false {
  $image = $Gates | Where-Object { $_.Name -eq $ImageGateName } | Select-Object -First 1
  if ($null -eq $image -or $image.Status -ne 'PASS') { return @{ Status = 'BLOCKED'; Exit = $null; Reason = "the image gate did not PASS (arm64 build / architecture proof / amd64 runtime smoke): nothing may be deferred" } }
  switch ($script:Arm64Runtime) {
    'PASS' { return @{ Exit = 0; Reason = $script:Arm64RuntimeDetail } }
    'FAIL' { return @{ Status = 'FAIL'; Exit = 1; Reason = $script:Arm64RuntimeDetail } }
    'DEFERRED' {
      if (-not (Live-Arm64-Gate-Present)) { return @{ Status = 'FAIL'; Exit = 1; Reason = 'the arm64 runtime smoke cannot run here and the migration has NO mandatory live Graviton gate (runbook step 12b + the edge-cutover guard): deferral refused' } }
      Log '    ARM64 runtime smoke: DEFERRED TO REQUIRED LIVE GRAVITON GATE (SINGLE_HOST_MIGRATION.md step 12b, gs-host arm64-smoke; migration-guard edge-cutover refuses the cutover without its PASS)' 'Yellow'
      return @{ Status = 'DEFERRED'; Exit = $null; Reason = 'ARM64 runtime smoke: DEFERRED TO REQUIRED LIVE GRAVITON GATE (step 12b; not PASS)' }
    }
    default { return @{ Status = 'NOT RUN'; Exit = $null; Reason = $script:Arm64RuntimeDetail } }
  }
} 'the linux/arm64 image-smoke.sh where this machine can execute arm64; otherwise DEFERRED (never PASS) to the REQUIRED live Graviton gate -- only after the arm64 build + architecture proof and the amd64 runtime smoke PASSED'

Add-Gate 'DynamoDB Local' $true {
  $endpoint = $env:GS_DYNAMODB_LOCAL_ENDPOINT
  $started = $null
  if ([string]::IsNullOrEmpty($endpoint)) {
    if ($null -eq $Docker) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'docker is not on PATH and GS_DYNAMODB_LOCAL_ENDPOINT is not set' } }
    $code = Invoke-Logged $Docker @('info', '--format', '{{.ServerVersion}}') $RepoRoot
    if ($code -ne 0) { return @{ Status = 'NOT RUN'; Exit = $code; Reason = 'the Docker daemon is not running (start Docker Desktop)' } }
    $name = "cost2c-owner-gate-ddb-$Stamp".ToLower()
    $code = Invoke-Logged $Docker @('run', '-d', '--rm', '--name', $name, '-p', '127.0.0.1:8000:8000', 'amazon/dynamodb-local:3.3.1', '-jar', 'DynamoDBLocal.jar', '-inMemory') $RepoRoot
    if ($code -ne 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = 'READINESS: DynamoDB Local could not be started (is 127.0.0.1:8000 already in use?)' } }
    $started = $name
    $endpoint = 'http://127.0.0.1:8000'
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
      # Ready = DynamoDB Local ANSWERS HTTP (any status, e.g. 400 for an unsigned request); a refused / reset connection is not.
      try {
        $req = [System.Net.WebRequest]::Create($endpoint)
        $req.Timeout = 2000
        $resp = $req.GetResponse(); $resp.Close(); $ready = $true
      } catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) { $ready = $true } else { Start-Sleep -Seconds 1 }
      } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) {
      Invoke-Logged $Docker @('logs', $started) $RepoRoot | Out-Null
      Invoke-Logged $Docker @('stop', $started) $RepoRoot | Out-Null
      return @{ Status = 'FAIL'; Exit = $null; Reason = 'READINESS: DynamoDB Local did not accept connections within 60 s (not a test failure)' }
    }
    Log "    DynamoDB Local is accepting connections at $endpoint (container $started)"
  } else {
    Log "    using the already-set GS_DYNAMODB_LOCAL_ENDPOINT=$endpoint (nothing started)"
  }
  try {
    $code = Invoke-Logged $Npm @('run', 'test:dynamodb-local') $ServerDir @{ GS_DYNAMODB_LOCAL_ENDPOINT = $endpoint }
  } finally {
    if ($null -ne $started) { Invoke-Logged $Docker @('stop', $started) $RepoRoot | Out-Null }
  }
  return @{ Exit = $code }
} 'npm run test:dynamodb-local with GS_DYNAMODB_LOCAL_ENDPOINT (a throw-away amazon/dynamodb-local:3.3.1 container on 127.0.0.1:8000, stopped and removed after)'

Add-Gate 'Full server suite' $true {
  if ($null -eq $Npm) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'npm is not on PATH' } }
  return @{ Exit = (Invoke-Logged $Npm @('test') $ServerDir) }
} 'npm test   (server: the complete corpus -- OWNER-RUN ONLY)'

# ---------------------------------------------------------------------------------------------------------------------
# Environment and source (always)
# ---------------------------------------------------------------------------------------------------------------------
$T0 = [DateTime]::UtcNow
$Watch = [System.Diagnostics.Stopwatch]::StartNew()
Log '========================================================================================================'
Log ' RECON-1 OWNER GATE (the reconciled single-host migration candidate; COST-2C runner, extended)'
Log '========================================================================================================'
Log (" start (UTC):        {0}" -f (UtcNow))
Log (" repository:         {0}" -f $RepoRoot)
Log (" log:                {0}" -f $(if ($ListOnly) { "(none: -ListOnly)" } else { $LogPath }))
Log (" PowerShell:         {0} ({1})" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
function ToolLine([string]$Label, $Exe, [string[]]$VersionArgs) {
  if ($null -eq $Exe) { Log (" {0,-19} NOT FOUND" -f ($Label + ':')); return }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $v = (& $Exe @VersionArgs 2>&1 | Select-Object -First 1) } catch { $v = "(error: $($_.Exception.Message))" }
  $ErrorActionPreference = $prev
  Log (" {0,-19} {1}  [{2}]" -f ($Label + ':'), $v, $Exe)
}
ToolLine 'node' $Node @('--version')
ToolLine 'npm' $Npm @('--version')
ToolLine 'git' $Git @('--version')
ToolLine 'terraform' $Terraform @('version')
ToolLine 'docker' $Docker @('--version')
ToolLine 'bash (Git Bash)' $Bash @('--version')
$Head = '(unknown)'; $Branch = '(unknown)'; $Dirty = @()
if ($null -ne $Git) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $Head = (& $Git -C $RepoRoot rev-parse HEAD 2>&1 | Select-Object -First 1)
  $Branch = (& $Git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>&1 | Select-Object -First 1)
  $Dirty = @(& $Git -C $RepoRoot status --short 2>&1)
  $Autocrlf = (& $Git -C $RepoRoot config --get core.autocrlf 2>&1 | Select-Object -First 1)
  $ErrorActionPreference = $prev
  Log (" branch:             {0}" -f $Branch)
  Log (" HEAD:               {0}" -f $Head)
  Log (" core.autocrlf:      {0}" -f $Autocrlf)
  Log ' git status --short:'
  if ($Dirty.Count -eq 0) { Log '   (clean)' } else {
    foreach ($l in $Dirty) { Log ("   {0}" -f $l) }
    Log '   !!! THE WORKING TREE IS NOT CLEAN: these results are for the tree above, NOT for the commit alone !!!' 'Yellow'
  }
}
Log '--------------------------------------------------------------------------------------------------------'
Log ' manifest (in order):'
foreach ($g in $Gates) { Log ("   {0,-32} {1}" -f $g.Name, $g.Describe) }
Log '--------------------------------------------------------------------------------------------------------'

if ($ListOnly) { Log 'ListOnly: nothing was run.'; exit 0 }

# ---------------------------------------------------------------------------------------------------------------------
# The gates
# ---------------------------------------------------------------------------------------------------------------------
$BuildOk = $true
$DepsOk = $true
foreach ($g in $Gates) {
  if ($Only.Count -gt 0 -and -not ($Only -contains $g.Name)) { $g.Status = 'SKIPPED'; $g.Reason = 'not selected (-Only)'; continue }
  $g.Started = UtcNow
  Log ''
  Log ("=== GATE: {0}   (start {1})" -f $g.Name, $g.Started) 'White'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if ($g.NeedsDeps -and -not $DepsOk) {
    $g.Status = 'BLOCKED'; $g.Reason = 'the locked dependency install (npm ci) failed or did not run: never run over stale dependencies'
  } elseif ($g.NeedsBuild -and -not $BuildOk) {
    $g.Status = 'BLOCKED'; $g.Reason = 'the build failed or did not run: its output would be stale or missing'
  } else {
    try {
      $r = & $g.Body
      $g.Exit = $r.Exit
      if ($r.ContainsKey('Status')) { $g.Status = $r.Status } elseif ($r.Exit -eq 0) { $g.Status = 'PASS' } else { $g.Status = 'FAIL' }
      if ($r.ContainsKey('Reason')) { $g.Reason = $r.Reason }
    } catch {
      $g.Status = 'FAIL'; $g.Reason = "the gate itself failed: $($_.Exception.Message)"
    }
  }
  if ($g.Name -eq 'Build' -and $g.Status -ne 'PASS') { $BuildOk = $false }
  if ($g.Name -eq 'Dependencies (npm ci)' -and $g.Status -ne 'PASS') { $DepsOk = $false; $BuildOk = $false }
  $sw.Stop()
  $g.Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $g.Ended = UtcNow
  $color = if ($g.Status -eq 'PASS') { 'Green' } elseif ($g.Status -eq 'DEFERRED') { 'Yellow' } else { 'Red' }
  Log ("=== {0}: {1}   exit {2}   {3} s   (end {4}){5}" -f $g.Name, $g.Status, $(if ($null -eq $g.Exit) { '-' } else { $g.Exit }), $g.Seconds, $g.Ended, $(if ($g.Reason) { "   -- $($g.Reason)" } else { '' })) $color
}

# ---------------------------------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------------------------------
$Watch.Stop()
# OWNER-GATE FIX 1: the OWNER SOURCE GATE passes when every gate PASSED, except that the ONE deferrable check -- the arm64
# runtime smoke -- may be DEFERRED to the required live Graviton gate, and only beside a PASSING image gate (the arm64
# build + architecture proof and the amd64 runtime smoke). DEFERRED is never reported as PASS; the live host
# certification (that smoke, the AL2023 / systemd drills) stays PENDING and is a prerequisite of the edge cutover.
$Deferrable = @($Arm64RuntimeGateName)
$ImageGatePassed = (@($Gates | Where-Object { $_.Name -eq $ImageGateName -and $_.Status -eq 'PASS' }).Count -eq 1)
$Deferred = @($Gates | Where-Object { $_.Status -eq 'DEFERRED' })
$AllPass = (@($Gates | Where-Object { $_.Status -ne 'PASS' -and -not ($_.Status -eq 'DEFERRED' -and $Deferrable -contains $_.Name -and $ImageGatePassed) }).Count -eq 0)
$LivePrerequisites = @(
  'ARM64 runtime smoke on the real Graviton host (SINGLE_HOST_MIGRATION.md step 12b: gs-host arm64-smoke; migration-guard edge-cutover --arm64-live-smoke refuses the cutover without its PASS)',
  'the AL2023 / systemd host-cert drills on the real host (F7 graceful-stop, F8 crash-/reboot-restart, F9 duplicate-preflight / duplicate-fence)'
)
# PHASE 1 CERTIFICATION CLOSURE: Windows PowerShell 5.1 is PROVEN only on Windows and only by the three gs-host.ps1 gates
# themselves (each PASS means the child's own header said 5.1 / Desktop and named the candidate's gs-host.ps1) -- never
# inferred from another engine, never claimed where it cannot run.
$PsGateResults = @($Gates | Where-Object { $GsHostPsGateNames -contains $_.Name })
$PsFacts = $script:Facts['gs_host_powershell']
$PsTotals = (@($PsFacts.Keys | ForEach-Object { "$_ $($PsFacts[$_].passed)/$($PsFacts[$_].failed)" }) -join ', ')
if (-not $OnWindows) {
  $Ps51 = 'NOT PROVEN'
  $Ps51Detail = "not Windows: the gs-host.ps1 regressions ran under PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) only ($PsTotals)"
} elseif ($PsGateResults.Count -eq $GsHostPsGateNames.Count -and @($PsGateResults | Where-Object { $_.Status -ne 'PASS' }).Count -eq 0) {
  $Ps51 = 'PROVEN'
  $Ps51Detail = "$(@($PsFacts.Values | ForEach-Object { $_.engine } | Select-Object -Unique) -join ', '), no -Target: $PsTotals"
} else {
  $Ps51 = 'NOT PROVEN'
  $Ps51Detail = (@($PsGateResults | Where-Object { $_.Status -ne 'PASS' } | ForEach-Object { "$($_.Name): $($_.Status)" }) -join '; ')
}
# The certifying run is the owner's on Windows: the OWNER SOURCE GATE passed AND Windows PowerShell 5.1 is PROVEN (on
# Windows the first implies the second). A PASS where 5.1 cannot run is a source gate PASS, NOT a certifying run -- the
# OVERALL line and the JSON (certifying_run) say so; it is never left to be inferred from the exit code.
$CertifyingRun = ($AllPass -and $Ps51 -eq 'PROVEN')
Log ''
Log '========================================================================================================'
Log ("{0,-52} {1,-8} {2,6}   {3}" -f 'Gate', 'Status', 'Exit', 'Duration')
Log ("{0,-52} {1,-8} {2,6}   {3}" -f '----', '------', '----', '--------')
foreach ($g in $Gates) {
  Log ("{0,-52} {1,-8} {2,6}   {3} s{4}" -f $g.Name, $g.Status, $(if ($null -eq $g.Exit) { '-' } else { $g.Exit }), $g.Seconds, $(if ($g.Reason) { "   ($($g.Reason))" } else { '' }))
}
Log ''
Log ("OWNER SOURCE GATE: {0}" -f $(if ($AllPass) { 'PASS' } else { 'FAIL' })) $(if ($AllPass) { 'Green' } else { 'Red' })
foreach ($d in $Deferred) { Log ("  deferred (NOT PASS): {0} -- {1}" -f $d.Name, $d.Reason) 'Yellow' }
Log ("WINDOWS POWERSHELL 5.1 (the gs-host.ps1 regressions, as documented): {0} -- {1}" -f $Ps51, $Ps51Detail) $(if ($Ps51 -eq 'PROVEN') { 'Green' } else { 'Yellow' })
Log 'LIVE HOST CERTIFICATION: PENDING -- required before any edge cutover:' 'Yellow'
foreach ($p in $LivePrerequisites) { Log ("  - {0}" -f $p) 'Yellow' }
Log ("OVERALL: {0}" -f $(if ($CertifyingRun) { 'PASS (OWNER SOURCE GATE; LIVE HOST CERTIFICATION PENDING)' } elseif ($AllPass) { 'PASS (OWNER SOURCE GATE; LIVE HOST CERTIFICATION PENDING) -- NOT A CERTIFYING RUN: Windows PowerShell 5.1 NOT PROVEN here (the certifying run is on Windows)' } else { 'FAIL' })) $(if ($CertifyingRun) { 'Green' } elseif ($AllPass) { 'Yellow' } else { 'Red' })
Log ("total duration: {0} s   (end {1})" -f [math]::Round($Watch.Elapsed.TotalSeconds, 1), (UtcNow))
if ($Dirty.Count -gt 0) { Log '!!! the working tree was NOT clean (see the top of the log) !!!' 'Yellow' }

$summary = [ordered]@{
  format = '18COSMOS/RECON-1-OWNER-GATE/v1'
  started_utc = $T0.ToString('yyyy-MM-ddTHH:mm:ssZ')
  finished_utc = (UtcNow)
  repository = $RepoRoot
  branch = [string]$Branch
  head = [string]$Head
  tree_clean = ($Dirty.Count -eq 0)
  dirty = @($Dirty | ForEach-Object { [string]$_ })
  powershell = [string]$PSVersionTable.PSVersion
  overall = $(if ($AllPass) { 'PASS' } else { 'FAIL' })
  owner_source_gate = $(if ($AllPass) { 'PASS' } else { 'FAIL' })
  live_host_certification = 'PENDING'
  windows_powershell_51 = $Ps51
  windows_powershell_51_detail = $Ps51Detail
  certifying_run = $CertifyingRun
  live_prerequisites = $LivePrerequisites
  deferred_to_live = @($Deferred | ForEach-Object { [ordered]@{ gate = $_.Name; reason = $_.Reason } })
  total_seconds = [math]::Round($Watch.Elapsed.TotalSeconds, 1)
  pinned_images = [ordered]@{ al2023 = $Al2023Image; node_linux = $NodeLinuxImage; docker_cli = $DockerCliImage }
  facts = $script:Facts
  gates = @($Gates | ForEach-Object { [ordered]@{ name = $_.Name; status = $_.Status; exit = $_.Exit; seconds = $_.Seconds; started_utc = $_.Started; ended_utc = $_.Ended; reason = $_.Reason } })
  log = $LogPath
}
[System.IO.File]::WriteAllText($JsonPath, ($summary | ConvertTo-Json -Depth 5), $Utf8)
Log ''
Log 'OWNER GATE LOG:'
Log $LogPath
Log 'OWNER GATE SUMMARY:'
Log $JsonPath
$script:Writer.Close()
if ($AllPass) { exit 0 } else { exit 1 }
