# infra/aws/single-host/tests/gs-host-role-probe.test.ps1 -- PHASE 1 REMAINDER (F5 / F6) regression for gs-host.ps1's
# `role-probe`: the remote command is built ONLY from the fixed template, the reviewed host-role-probe.sh (base64,
# LF-normalised) and the validated digest / run id / probe / generation / pool -- nothing the caller types can reach a
# shell on the host -- and the 083d066 multiline-stderr fix still lets no failed host command through.
#
# OFFLINE ONLY. No AWS, no network: `aws.exe` and `Start-Sleep` are shadowed by functions (the same fakes as
# gs-host-stderr.test.ps1), and the test refuses to run unless `aws.exe` resolves to that fake.
#
#   Windows PowerShell 5.1:  powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\aws\single-host\tests\gs-host-role-probe.test.ps1
#   PowerShell 7:            pwsh -NoProfile -File ./infra/aws/single-host/tests/gs-host-role-probe.test.ps1
[CmdletBinding()]
param([string]$Target = (Join-Path (Split-Path -Parent $PSScriptRoot) 'gs-host.ps1'))
$ErrorActionPreference = 'Stop'
$Target = (Resolve-Path -LiteralPath $Target).Path
$ProbeScript = Join-Path (Split-Path -Parent $Target) 'host-role-probe.sh'
$global:GsSelf = (Get-Process -Id $PID).Path
$script:Passed = 0
$script:Failed = 0
$Instance = 'i-0123456789abcdef0'
$Digest = 'sha256:' + ('ab' * 32)

$global:GsFake = $null
function global:Start-Sleep { param([double]$Seconds, [int]$Milliseconds) }
function global:aws.exe {
  $a = @($args | ForEach-Object { [string]$_ })
  $f = $global:GsFake
  [void]$f.Calls.Add(($a -join ' '))
  $opt = { param($name) $i = [array]::IndexOf($a, $name); if ($i -ge 0 -and $i + 1 -lt $a.Count) { $a[$i + 1] } else { $null } }
  if ($a[0] -ne 'ssm') { $global:LASTEXITCODE = 2; return }
  switch ($a[1]) {
    'send-command' {
      $p = (& $opt '--parameters') -replace '^file://', ''
      $f.ParamsFile = $p
      $f.ParamsExisted = Test-Path -LiteralPath $p
      if ($f.ParamsExisted) { $f.ParamsText = [System.IO.File]::ReadAllText($p) }
      $f.Comment = & $opt '--comment'
      $global:LASTEXITCODE = 0
      return 'cmd-0001'
    }
    'get-command-invocation' {
      switch (& $opt '--query') {
        'Status' {
          $f.Polls += 1
          $global:LASTEXITCODE = 0
          if ($f.Polls -lt 2) { return 'InProgress' }
          return $f.Status
        }
        'StandardOutputContent' { return (Emit-Native $f.Stdout) }
        'StandardErrorContent' { return (Emit-Native $f.Stderr) }
      }
    }
  }
  $global:LASTEXITCODE = 2
}
function global:Emit-Native([string]$text) {
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text + "`n"))
  $cmd = "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')))"
  & $global:GsSelf -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd)))
}

try {
$resolved = Get-Command aws.exe
if ($resolved.CommandType -ne 'Function') { throw "gs-host-role-probe.test: REFUSED: aws.exe resolves to $($resolved.CommandType) $($resolved.Source), not the offline fake" }

function Invoke-GsHost {
  param([string]$Status = 'Success', [string]$Stdout = 'GS-HOST-ROLE-PROBE BEGIN', [string]$Stderr = '', [hashtable]$Argv)
  $global:GsFake = @{ Status = $Status; Stdout = $Stdout; Stderr = $Stderr; Polls = 0; Calls = New-Object System.Collections.ArrayList; ParamsFile = $null; ParamsExisted = $false; ParamsText = $null; Comment = $null }
  $records = New-Object System.Collections.ArrayList
  $thrown = $null
  try { & $Target @Argv *>&1 | ForEach-Object { [void]$records.Add($_) } } catch { $thrown = $_ }
  [pscustomobject]@{
    Thrown = $(if ($thrown) { $thrown.Exception.Message } else { $null })
    Warnings = @($records | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message })
    Output = @($records | Where-Object { $_ -is [string] })
    Calls = @($global:GsFake.Calls)
    ParamsText = $global:GsFake.ParamsText
    Comment = $global:GsFake.Comment
    ParamsRemoved = $(if ($global:GsFake.ParamsFile) { -not (Test-Path -LiteralPath $global:GsFake.ParamsFile) } else { $true })
  }
}
function Check([string]$name, [scriptblock]$cond, $r) {
  $ok = $false
  try { $ok = [bool](& $cond) } catch { $ok = $false }
  if ($ok) { $script:Passed += 1; Write-Host "PASS  $name" }
  else { $script:Failed += 1; Write-Host "FAIL  $name"; Write-Host ("      thrown=[{0}] calls={1} params=[{2}]" -f $r.Thrown, $r.Calls.Count, $r.ParamsText) }
}
function Probe-Argv([hashtable]$Over = @{}) {
  $base = @{ Command = 'role-probe'; InstanceId = $Instance; Digest = $Digest; RunId = 'phase1-f5-0001'; Probe = 'kms'; Generation = 1; Pool = 'p1' }
  foreach ($k in $Over.Keys) { if ($null -eq $Over[$k]) { $base.Remove($k) } else { $base[$k] = $Over[$k] } }
  $base
}

$expectedText = [System.IO.File]::ReadAllText($ProbeScript) -replace "`r`n", "`n"
$expectedB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($expectedText))
Write-Host "gs-host role-probe regression -- PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) -- $Target"

# R1. The remote command is exactly the fixed template: the reviewed wrapper, then the validated arguments.
$r = Invoke-GsHost -Stdout "GS-HOST-ROLE-PROBE BEGIN`nL6CERT/v1 1/1 $('0' * 64) e30=`nGS-HOST-ROLE-PROBE END exit=0" -Argv (Probe-Argv)
$params = $(if ($r.ParamsText) { $r.ParamsText | ConvertFrom-Json } else { $null })
$remote = $(if ($params) { [string]$params.commands[0] } else { '' })
$want = "d=`$(mktemp -d) && printf %s $expectedB64 | base64 -d > `$d/p && bash `$d/p $Digest phase1-f5-0001 kms 1 p1; rc=`$?; rm -rf `$d; exit `$rc"
Check 'R1 role-probe sends exactly the fixed template (wrapper, digest, run id, probe, generation, pool)' { -not $r.Thrown -and $remote -eq $want } $r
Check 'R1 the wrapper sent is the repository file, LF-normalised' { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($remote -split ' ')[5])) -eq $expectedText } $r
Check 'R1 the remote line holds no quote character' { $remote.Length -gt 0 -and $remote -notmatch "['`"]" } $r
Check 'R1 one SSM document, the 900 s execution timeout, the comment names the command' { $r.Calls[0] -match '--document-name AWS-RunShellScript' -and [string]$params.executionTimeout[0] -eq '900' -and $r.Comment -eq 'gs-host role-probe' } $r
Check 'R1 the host output (the record lines) is passed through unchanged' { ($r.Output -join '|') -eq "GS-HOST-ROLE-PROBE BEGIN|L6CERT/v1 1/1 $('0' * 64) e30=|GS-HOST-ROLE-PROBE END exit=0" } $r
Check 'R1 temp parameter file removed' { $r.ParamsRemoved } $r

# R2. transactions (F6) is the same template with that probe name.
$r = Invoke-GsHost -Argv (Probe-Argv @{ Probe = 'transactions'; RunId = 'phase1-f6-0001'; Generation = 1 })
Check 'R2 transactions: the same template, probe transactions' { -not $r.Thrown -and (($r.ParamsText | ConvertFrom-Json).commands[0]) -match " bash \`$d/p $Digest phase1-f6-0001 transactions 1 p1; rc=" } $r

# R3. Missing arguments: REFUSED, nothing sent.
foreach ($missing in @('Digest', 'RunId', 'Probe', 'Generation', 'Pool')) {
  $r = Invoke-GsHost -Argv (Probe-Argv @{ $missing = $null })
  Check "R3 without -$missing`: REFUSED, nothing sent" { $r.Thrown -match '^gs-host: REFUSED: role-probe needs' -and $r.Calls.Count -eq 0 } $r
}

# R4. Hostile or malformed values never reach the host: parameter validation refuses them before anything is sent.
$hostile = @(
  @{ RunId = 'abc123; reboot' }, @{ RunId = 'ABCDEF1' }, @{ RunId = 'run$(id)x' }, @{ Probe = 'kms; reboot' }, @{ Probe = 'all' }, @{ Probe = 'KMS' },
  @{ Pool = 'p1;id' }, @{ Pool = 'p1 p2' }, @{ Pool = '$(id)' }, @{ Pool = 'P1' }, @{ Digest = 'sha256:abc' }, @{ Digest = "$Digest;id" }, @{ Digest = $Digest.ToUpper() },
  @{ Generation = 0 }, @{ Generation = 10000 },
  @{ RunId = "reboot`n" }, @{ RunId = "phase1-f5-0001`nreboot" }, @{ Pool = "p1`n" }, @{ Digest = "$Digest`n" }, @{ Digest = "$Digest`r" }, @{ Probe = "kms`n" }
)
foreach ($h in $hostile) {
  $r = Invoke-GsHost -Argv (Probe-Argv $h)
  $label = ($h.Keys | ForEach-Object { "-$_ $($h[$_])" }) -join ' '
  Check "R4 $label`: refused, nothing sent" { $r.Thrown -and $r.Calls.Count -eq 0 } $r
}

# R5. The 083d066 fix holds for role-probe: a FAILED host command with multiline stderr is REFUSED (stderr shown).
$r = Invoke-GsHost -Status 'Failed' -Stdout "GS-HOST-ROLE-PROBE BEGIN`nrefused=the game server is not active`nGS-HOST-ROLE-PROBE END exit=93" -Stderr "line one`nline two" -Argv (Probe-Argv)
Check 'R5 Failed + multiline stderr: REFUSED: the host command ended Failed.' { $r.Thrown -eq 'gs-host: REFUSED: the host command ended Failed.' -and $r.Warnings.Count -eq 1 -and $r.Warnings[0] -match 'line two' -and $r.ParamsRemoved } $r
$r = Invoke-GsHost -Status 'Failed' -Stderr "line one`nline two" -Argv ((Probe-Argv) + @{ WarningAction = 'Stop' })
Check 'R5 ... and with -WarningAction Stop' { $r.Thrown -eq 'gs-host: REFUSED: the host command ended Failed.' } $r

# R5b. The same line-break refusal guards the pre-existing commands (deploy's digest and build id reach the host too).
foreach ($d in @(@{ Digest = "$Digest`n"; BuildId = 'b1' }, @{ Digest = $Digest; BuildId = "b1`nreboot" })) {
  $r = Invoke-GsHost -Argv (@{ Command = 'deploy'; InstanceId = $Instance } + $d)
  Check "R5b deploy with a line break in $(($d.Keys | Sort-Object) -join '/'): refused, nothing sent" { $r.Thrown -and $r.Calls.Count -eq 0 } $r
}

# R6. The other commands are unchanged (status still sends exactly gs-health).
$r = Invoke-GsHost -Stdout 'ok' -Argv @{ Command = 'status'; InstanceId = $Instance }
Check 'R6 status: exactly /opt/gs/bin/gs-health' { -not $r.Thrown -and $r.ParamsText -match '"commands":\["/opt/gs/bin/gs-health"\]' } $r
}
finally {
  Remove-Item -Path function:\aws.exe, function:\Start-Sleep, function:\Emit-Native -ErrorAction SilentlyContinue
  Remove-Variable -Name GsFake, GsSelf -Scope Global -ErrorAction SilentlyContinue
}
Write-Host "gs-host role-probe regression: $($script:Passed) passed / $($script:Failed) failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
