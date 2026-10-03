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
     3  Build                  the server TypeScript build (`npm run build`'s own command) = the typecheck
     4  RECON-1 authorization  deploy/migration/recon1AuthorizationGates (app-read-authorize, ledger-operator-journal,
                               X-09, the Terraform-made plans, plan-evidence.ps1's targets / CR record -- its PowerShell
                               test must RUN here: a SKIP of it FAILS the gate -- and host-cert's credential authority /
                               stale-host classification)
     5  COST-2B migration      deploy/migration/cost2bMigrationGuards
     6  COST-2C targeted       aws/deploy/hostcert/hostCert.test.js -- the host drills F7 / F8 / F9a / F9b / replacement,
                               the systemd / HOLD evidence judges, the drill lock, false-PASS / NOT-EVALUATED cases,
                               the bash templates and gs-exit-hold parity, the --host-transport-profile authority
                               (Git Bash: a SKIP here is NOT RUN, not PASS)
     7  COST-2A verifier       deploy/cost2aHostVerifier (+ W-02), operator/cost2aHostSnapshot (its .ps1 captures run
                               under Windows PowerShell / pwsh)
     8  JX-4C / P5             operator/jx4cOperatorEvidenceIam, runtime/p5IntCrossSlice
     9  Ownership / fencing    rooms/l5_3Ownership, conformance/fenceGap, aws/awsClients (import / binding guards),
                               conformance/l6_5bAlarms
    10  awsDeploy / stage-cert deploy/l5_8Deploy, staging/l6_6StagingCert, staging/rotationProof (incl. L6-14W1
                               04138ea), staging/restoreFencing
    11  COST-1 + portability   deploy/cost1SingleHost (W-03 / W-04 + the host-cert scripts' LF), runtime/singleHostMetrics
    12  Terraform              fmt -check (infra/aws), `terraform test` in modules/single-host (20), modules/app (69),
                               modules/ledger (34); init -backend=false + validate in stacks/app, stacks/ledger,
                               stacks/single-host (mocked providers: no AWS account, no credentials)
    13  Single-host scripts    infra/aws/modules/single-host/tests/host-scripts.test.sh (Git Bash)
    14  DynamoDB Local         the full `npm run test:dynamodb-local` corpus (JX-4B's money evidence and COST-2C's drill
                               lock -- hostCertLock.dynamoLocal.test.js -- are part of it). Starts ONE throw-away
                               `amazon/dynamodb-local:3.3.1` container (the repository's documented procedure) and
                               removes only that container -- unless GS_DYNAMODB_LOCAL_ENDPOINT is already set, which
                               is then used and nothing is started.
    15  Full server suite      the complete server `npm test` corpus (LAST: the longest gate; OWNER-RUN ONLY)

  Nothing here touches AWS, Juno or any remote resource. The script never edits, cleans, resets or stashes the tree.
  Exit code: 0 only when EVERY gate passed; 1 otherwise (a FAIL, a BLOCKED gate after a failed build, or a NOT RUN
  gate whose prerequisite -- Terraform, Docker, Git Bash, git -- is missing).
  It certifies the SOURCE only: the live AL2023 / systemd contract stays NOT EVALUATED until the real-host drill.

.PARAMETER Only
  Run only these gates (names as in the summary table, e.g. -Only Build,"COST-2C targeted"). The environment section
  always runs. Gates not selected are reported SKIPPED and the overall result is then never PASS.

.PARAMETER ListOnly
  Print the manifest (every command, in order) and the environment, run nothing, exit 0.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\infra\aws\single-host\run-cost2c-owner-gate.ps1
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
function Add-Gate([string]$Name, [bool]$NeedsBuild, [scriptblock]$Body, [string]$Describe) {
  [void]$Gates.Add([pscustomobject]@{ Name = $Name; NeedsBuild = $NeedsBuild; Body = $Body; Describe = $Describe; Status = 'SKIPPED'; Exit = $null; Seconds = 0.0; Reason = ''; Started = ''; Ended = '' })
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

Add-Gate 'Build' $false {
  if ($null -eq $Node) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'node is not on PATH' } }
  $tsc = Join-Path $FrontendDir 'node_modules/typescript/bin/tsc'
  if (-not (Test-Path $tsc)) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'frontend\node_modules\typescript is missing (npm ci in frontend\ first)' } }
  if (-not (Test-Path (Join-Path $ServerDir 'node_modules/@aws-sdk/client-dynamodb'))) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'server\node_modules is missing (npm ci in server\ first)' } }
  $code = Invoke-Logged $Node @('../frontend/node_modules/typescript/bin/tsc', '-p', 'tsconfig.json') $ServerDir
  return @{ Exit = $code }
} 'node ../frontend/node_modules/typescript/bin/tsc -p tsconfig.json   (server; = npm run build)'

Add-Gate 'RECON-1 authorization gates' $true {
  $code = Invoke-Logged $Node (TestArgs @('aws/deploy/migration/recon1AuthorizationGates.test.js')) $ServerDir
  $skippedPs = @($script:LastOutput | Where-Object { $_ -match 'plan-evidence\.ps1' -and $_ -match '# SKIP' })
  if ($code -eq 0 -and $OnWindows -and $skippedPs.Count -gt 0) { return @{ Status = 'FAIL'; Exit = $code; Reason = "plan-evidence.ps1's test was SKIPPED (no Windows PowerShell / pwsh found): the Windows capture path was NOT RUN" } }
  return @{ Exit = $code }
} 'node --test deploy/migration/recon1AuthorizationGates   (on Windows its plan-evidence.ps1 test must run)'

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
  if ($null -eq $Bash) { return @{ Status = 'NOT RUN'; Exit = $null; Reason = 'Git Bash (bash.exe of Git for Windows) not found' } }
  return @{ Exit = (Invoke-Logged $Bash @('infra/aws/modules/single-host/tests/host-scripts.test.sh') $RepoRoot) }
} 'bash infra/aws/modules/single-host/tests/host-scripts.test.sh   (Git Bash)'

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
foreach ($g in $Gates) {
  if ($Only.Count -gt 0 -and -not ($Only -contains $g.Name)) { $g.Status = 'SKIPPED'; $g.Reason = 'not selected (-Only)'; continue }
  $g.Started = UtcNow
  Log ''
  Log ("=== GATE: {0}   (start {1})" -f $g.Name, $g.Started) 'White'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  if ($g.NeedsBuild -and -not $BuildOk) {
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
  $sw.Stop()
  $g.Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $g.Ended = UtcNow
  $color = if ($g.Status -eq 'PASS') { 'Green' } else { 'Red' }
  Log ("=== {0}: {1}   exit {2}   {3} s   (end {4}){5}" -f $g.Name, $g.Status, $(if ($null -eq $g.Exit) { '-' } else { $g.Exit }), $g.Seconds, $g.Ended, $(if ($g.Reason) { "   -- $($g.Reason)" } else { '' })) $color
}

# ---------------------------------------------------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------------------------------------------------
$Watch.Stop()
$AllPass = (@($Gates | Where-Object { $_.Status -ne 'PASS' }).Count -eq 0)
Log ''
Log '========================================================================================================'
Log ("{0,-34} {1,-8} {2,6}   {3}" -f 'Gate', 'Status', 'Exit', 'Duration')
Log ("{0,-34} {1,-8} {2,6}   {3}" -f '----', '------', '----', '--------')
foreach ($g in $Gates) {
  Log ("{0,-34} {1,-8} {2,6}   {3} s{4}" -f $g.Name, $g.Status, $(if ($null -eq $g.Exit) { '-' } else { $g.Exit }), $g.Seconds, $(if ($g.Reason) { "   ($($g.Reason))" } else { '' }))
}
Log ''
Log ("OVERALL: {0}" -f $(if ($AllPass) { 'PASS' } else { 'FAIL' })) $(if ($AllPass) { 'Green' } else { 'Red' })
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
  total_seconds = [math]::Round($Watch.Elapsed.TotalSeconds, 1)
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
