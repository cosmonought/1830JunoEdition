# infra/aws/single-host/gs-host.ps1 -- COST-1: the OPERATOR's side of the single host, for the Windows workflow (the bash
# twin is gs-host.sh). Runs ONE fixed host command through SSM Run Command (AWS-RunShellScript, public SSM endpoints,
# free on EC2) and prints its output. No SSH. Every argument is validated HERE; the remote command is built only from
# fixed templates. Needs AWS CLI v2 (aws.exe -- a CLI v1 aws.cmd is refused, as elsewhere in infra/aws) and operator
# credentials allowed ssm:SendCommand (AWS-RunShellScript) on the instance and ssm:GetCommandInvocation.
#
#   .\gs-host.ps1 -Command status   -InstanceId i-...
#   .\gs-host.ps1 -Command deploy   -InstanceId i-... -Digest sha256:<64 hex> -BuildId <id> [-Measure]
#   .\gs-host.ps1 -Command rollback -InstanceId i-...
#   .\gs-host.ps1 -Command stop     -InstanceId i-... [-UntilDeploy]
#   .\gs-host.ps1 -Command measure-report -InstanceId i-... [-Days 14]
#   .\gs-host.ps1 -Command arm64-smoke -InstanceId i-... -Digest sha256:<64 hex>      # step 12b: BEFORE deploy / edge cutover
#   .\gs-host.ps1 -Command role-probe -InstanceId i-... -Digest sha256:<64 hex> -RunId <run> -Probe kms|transactions -Generation 1 -Pool p1   # F5 / F6
#   .\gs-host.ps1 -Command install-script -InstanceId i-... -HostScript gs-preflight -Sha256 <certified> -ReplacesSha256 <live> [-Check]   # 13r
#
# arm64-smoke (OWNER-GATE FIX 1): the REQUIRED live ARM64 runtime smoke on the real Graviton host. It sends the two
# REVIEWED repository files -- infra/aws/single-host/arm64-live-smoke.sh and the unchanged
# infra/aws/modules/single-host/tests/image-smoke.sh -- as base64 (LF-normalised; the remote line holds no quote), and the
# host runs the wrapper against the release pulled by digest. Save the output (Tee-Object) for
# `migration-guard edge-cutover --arm64-live-smoke <file>`: the cutover is refused unless it is a complete PASS.
#
# role-probe (PHASE 1 REMAINDER, F5 / F6): the L6-6 task-role probe (unchanged; the release image's own `awsDeploy
# stage-probe task-role`) run ON the host, under the INSTANCE ROLE, from the SERVING release by digest. It sends ONE
# reviewed repository file -- infra/aws/single-host/host-role-probe.sh -- as base64 (LF-normalised; the remote line holds
# no quote and nothing the caller typed beyond the validated digest, run id, probe, generation and pool). `kms` = F5
# (signing identities + disposable digest Signs, < 3 s each); `transactions` = F6 (plus the disposable L6CERT#<run>
# partition, read back empty). Save the output (Tee-Object) for `awsDeploy stage-probe host-role --capture <file>`.
#
# install-script (PHASE 1 FRESH-HOST HARDENING, runbook 13r): ONE certified host script onto the EXISTING host -- no host
# replacement. It reads this checkout's infra/aws/modules/single-host/files/bin/<HostScript> as EXACT bytes (a CR refuses: not
# an LF checkout), refuses unless their SHA-256 is -Sha256 (the certified one, typed from the certified record), and sends
# them (base64) with ONE reviewed repository file -- infra/aws/single-host/host-script-install.sh (LF-normalised) -- which
# on the host inspects the live file, requires the server down and the deploy lock, verifies the bytes and `bash -n`, and
# replaces only /opt/gs/bin/<HostScript> by one atomic rename (-ReplacesSha256: the live bytes it may replace). -Check verifies
# everything and writes nothing. It never starts, stops or deploys: the deploy that follows is the ordinary `deploy`.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'deploy', 'rollback', 'stop', 'measure-report', 'arm64-smoke', 'role-probe', 'install-script')][string]$Command,
  [Parameter(Mandatory = $true)][ValidatePattern('^i-[0-9a-f]{8,17}$')][string]$InstanceId,
  [ValidatePattern('^[a-z]{2}(-[a-z]+)+-[0-9]$')][string]$Region = 'us-east-1',
  [ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$Digest,
  [ValidatePattern('^[A-Za-z0-9._-]{1,128}$')][string]$BuildId,
  [switch]$Measure,
  [switch]$UntilDeploy,
  [ValidateRange(1, 365)][int]$Days = 14,
  [ValidatePattern('^[a-z0-9][a-z0-9-]{5,39}$')][string]$RunId,
  [ValidateSet('kms', 'transactions')][string]$Probe,
  [ValidateRange(1, 9999)][int]$Generation = 0,
  [ValidatePattern('^[a-z][a-z0-9-]{0,15}$')][string]$Pool,
  [ValidateSet('gs-preflight', 'gs-lib.sh', 'gs-health')][string]$HostScript,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$Sha256,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ReplacesSha256,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
# .NET's `$` also matches before a trailing newline, so ValidatePattern alone admits "sha256:<hex>`n" -- and AWS-RunShellScript
# runs every line of the remote command as root. No argument that reaches it may hold a line break (PHASE 1 REMAINDER review).
foreach ($value in @($Digest, $BuildId, $RunId, $Probe, $Pool, $HostScript, $Sha256, $ReplacesSha256)) {
  if ($value -and $value -match '[\r\n]') { throw 'gs-host: REFUSED: an argument holds a line break.' }
}
$aws = Get-Command aws.exe -ErrorAction SilentlyContinue
if (-not $aws) { throw 'gs-host: REFUSED: AWS CLI v2 (aws.exe) is required.' }

switch ($Command) {
  'status' { $remote = '/opt/gs/bin/gs-health' }
  'deploy' {
    if (-not $Digest -or -not $BuildId) { throw 'gs-host: REFUSED: deploy needs -Digest sha256:<64 hex> and -BuildId.' }
    $remote = "/opt/gs/bin/gs-deploy $Digest $BuildId" + $(if ($Measure) { ' --measure' } else { '' })
  }
  'rollback' { $remote = '/opt/gs/bin/gs-rollback' }
  'stop' { $remote = '/opt/gs/bin/gs-stop' + $(if ($UntilDeploy) { ' --until-deploy' } else { '' }) }
  'measure-report' { $remote = "/opt/gs/bin/gs-measure-report $Days" }
  'arm64-smoke' {
    if (-not $Digest) { throw 'gs-host: REFUSED: arm64-smoke needs -Digest sha256:<64 hex> (the release pushed at step 12).' }
    $b64 = {
      param($rel)
      $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot $rel)) -replace "`r`n", "`n"
      [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
    }
    $wrapper = & $b64 'arm64-live-smoke.sh'
    $smoke = & $b64 '..\modules\single-host\tests\image-smoke.sh'
    $remote = "d=`$(mktemp -d) && printf %s $wrapper | base64 -d > `$d/w && printf %s $smoke | base64 -d > `$d/s && bash `$d/w $Digest `$d/s; rc=`$?; rm -rf `$d; exit `$rc"
  }
  'role-probe' {
    if (-not $Digest -or -not $RunId -or -not $Probe -or $Generation -lt 1 -or -not $Pool) { throw 'gs-host: REFUSED: role-probe needs -Digest sha256:<64 hex> (the SERVING release), -RunId <run>, -Probe kms|transactions, -Generation <n> and -Pool <pool>.' }
    # ValidatePattern / ValidateSet are case-INSENSITIVE: the host's shapes are exact (lower case), so check them exactly here.
    if ($Digest -cnotmatch '^sha256:[0-9a-f]{64}\z' -or $RunId -cnotmatch '^[a-z0-9][a-z0-9-]{5,39}\z' -or $Probe -cnotmatch '^(kms|transactions)\z' -or $Pool -cnotmatch '^[a-z][a-z0-9-]{0,15}\z') { throw 'gs-host: REFUSED: role-probe arguments are lower case: -Digest sha256:<64 hex>, -RunId ^[a-z0-9][a-z0-9-]{5,39}$, -Probe kms|transactions, -Pool ^[a-z][a-z0-9-]{0,15}$.' }
    $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'host-role-probe.sh')) -replace "`r`n", "`n"
    $probeScript = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
    $remote = "d=`$(mktemp -d) && printf %s $probeScript | base64 -d > `$d/p && bash `$d/p $Digest $RunId $Probe $Generation $Pool; rc=`$?; rm -rf `$d; exit `$rc"
  }
  'install-script' {
    if (-not $HostScript -or -not $Sha256 -or -not $ReplacesSha256) { throw 'gs-host: REFUSED: install-script needs -HostScript gs-preflight|gs-lib.sh|gs-health, -Sha256 <the certified SHA-256> and -ReplacesSha256 <the live bytes it replaces>.' }
    # ValidateSet / ValidatePattern are case-INSENSITIVE: the host's shapes are exact (lower case), so check them exactly here.
    if ($HostScript -cnotmatch '^(gs-preflight|gs-lib\.sh|gs-health)\z' -or $Sha256 -cnotmatch '^[0-9a-f]{64}\z' -or $ReplacesSha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'gs-host: REFUSED: install-script arguments are lower case: -HostScript gs-preflight|gs-lib.sh|gs-health, -Sha256 / -ReplacesSha256 64 lower-case hex.' }
    # The EXACT bytes of this checkout's file, never re-encoded: a CR means a non-LF checkout, not the certified bytes.
    $bytes = [System.IO.File]::ReadAllBytes([System.IO.Path]::Combine($PSScriptRoot, '..', 'modules', 'single-host', 'files', 'bin', $HostScript))
    if ([Array]::IndexOf($bytes, [byte]13) -ge 0) { throw "gs-host: REFUSED: this checkout's $HostScript holds a CR (not an LF checkout of the certified commit): re-clone." }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $local = ([BitConverter]::ToString($hasher.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($local -cne $Sha256) { throw "gs-host: REFUSED: this checkout's $HostScript is sha256 $local, not the certified $Sha256 (check out the certified commit)." }
    $text = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'host-script-install.sh')) -replace "`r`n", "`n"
    $installer = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
    $content = [Convert]::ToBase64String($bytes)
    $mode = $(if ($Check) { 'check' } else { 'install' })
    Write-Host "gs-host: install-script $mode $HostScript -- this checkout's bytes are the certified sha256 $local; they replace $ReplacesSha256"
    $remote = "d=`$(mktemp -d) && printf %s $installer | base64 -d > `$d/i && printf %s $content | base64 -d > `$d/f && bash `$d/i $mode $HostScript $Sha256 $ReplacesSha256 `$d/f; rc=`$?; rm -rf `$d; exit `$rc"
  }
}

$params = New-TemporaryFile
try {
  @{ commands = @($remote); executionTimeout = @('900') } | ConvertTo-Json -Compress | Set-Content -Path $params -Encoding ascii
  $id = & aws.exe ssm send-command --region $Region --instance-ids $InstanceId --document-name AWS-RunShellScript `
    --comment "gs-host $Command" --parameters "file://$($params.FullName)" --timeout-seconds 600 --query Command.CommandId --output text
  if ($LASTEXITCODE -ne 0) { throw 'gs-host: REFUSED: send-command failed.' }
  Write-Host "gs-host: $Command on $InstanceId (command $id)"
  do {
    Start-Sleep -Seconds 5
    $status = & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query Status --output text 2>$null
    if ($LASTEXITCODE -ne 0) { $status = 'Pending' }
  } while ($status -in @('Pending', 'InProgress', 'Delayed'))
  & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query StandardOutputContent --output text
  $err = & aws.exe ssm get-command-invocation --region $Region --command-id $id --instance-id $InstanceId --query StandardErrorContent --output text
  # Multi-line stderr arrives as SEVERAL pipeline objects: join it into ONE string (Write-Warning -Message takes one), and
  # never let rendering it (e.g. -WarningAction Stop) skip the status check below. Regression: tests/gs-host-stderr.test.ps1.
  $errText = (@($err) -join [Environment]::NewLine).Trim()
  if ($errText -and $errText -ne 'None') {
    try { Write-Warning -Message $errText } catch { try { Write-Host "gs-host: host stderr:$([Environment]::NewLine)$errText" } catch { } }
  }
  if ($status -ne 'Success') { throw "gs-host: REFUSED: the host command ended $status." }
}
finally {
  Remove-Item -Path $params -ErrorAction SilentlyContinue
}
