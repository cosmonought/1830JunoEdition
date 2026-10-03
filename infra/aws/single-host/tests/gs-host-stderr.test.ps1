# infra/aws/single-host/tests/gs-host-stderr.test.ps1 -- PHASE 1 HOTFIX regression: gs-host.ps1 must render the SSM
# command's StandardErrorContent (which the AWS CLI returns as SEVERAL pipeline objects when it spans several lines)
# without ever skipping the final status check -- a host command that did not end Success is always REFUSED.
#
# Live incident (step 12b): the ARM64 smoke PASSED, but the wrapper died in `Write-Warning $err` with
# "Cannot convert 'System.Object[]' to the type 'System.String' required by parameter 'Message'" -- the same throw on a
# FAILED host command would have pre-empted "gs-host: REFUSED: the host command ended <status>."
#
# OFFLINE ONLY. No AWS, no network: `aws.exe` and `Start-Sleep` are shadowed by functions defined here (PowerShell's
# command precedence runs a function before a cmdlet or an external application of the same name), and the test refuses
# to run anything unless `aws.exe` resolves to that fake. The fake's stdout / stderr content is emitted by a REAL child
# process (this PowerShell's own executable), so gs-host.ps1 captures it exactly as it captures aws.exe's output: one
# pipeline object per line.
#
#   Windows PowerShell 5.1:  powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\aws\single-host\tests\gs-host-stderr.test.ps1
#   PowerShell 7:            pwsh -NoProfile -File ./infra/aws/single-host/tests/gs-host-stderr.test.ps1
#
# Exit 0 = every case passed. -Target runs the same cases against another copy of gs-host.ps1 (e.g. the unfixed one).
[CmdletBinding()]
param([string]$Target = (Join-Path (Split-Path -Parent $PSScriptRoot) 'gs-host.ps1'))
$ErrorActionPreference = 'Stop'
$Target = (Resolve-Path -LiteralPath $Target).Path
$global:GsSelf = (Get-Process -Id $PID).Path
$script:Passed = 0
$script:Failed = 0
$Instance = 'i-0123456789abcdef0'

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
# Print $text from a real child process, as the AWS CLI's `--output text` does (content, then a newline).
function global:Emit-Native([string]$text) {
  $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text + "`n"))
  $cmd = "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')))"
  & $global:GsSelf -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd)))
}

# Everything below runs inside try / finally: the global fakes never outlive this run, even when it is interrupted
# (Ctrl+C in an interactive console) -- a leftover aws.exe function would shadow the real CLI for a later gs-host.ps1.
try {
$resolved = Get-Command aws.exe
if ($resolved.CommandType -ne 'Function') { throw "gs-host-stderr.test: REFUSED: aws.exe resolves to $($resolved.CommandType) $($resolved.Source), not the offline fake" }

function Invoke-GsHost {
  param([string]$Status, [string]$Stdout, [string]$Stderr, [hashtable]$Extra = @{})
  $global:GsFake = @{ Status = $Status; Stdout = $Stdout; Stderr = $Stderr; Polls = 0; Calls = New-Object System.Collections.ArrayList; ParamsFile = $null; ParamsExisted = $false; ParamsText = $null }
  $records = New-Object System.Collections.ArrayList
  $thrown = $null
  $argv = @{ Command = 'status'; InstanceId = $Instance } + $Extra
  try { & $Target @argv *>&1 | ForEach-Object { [void]$records.Add($_) } } catch { $thrown = $_ }
  $warnings = @($records | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message })
  $hostLines = @($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { [string]$_.MessageData })
  $output = @($records | Where-Object { $_ -is [string] })
  $errors = @($records | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() })
  [pscustomobject]@{
    Thrown = $(if ($thrown) { $thrown.Exception.Message } else { $null })
    Warnings = $warnings; HostLines = $hostLines; Output = $output; Errors = $errors
    ParamsFile = $global:GsFake.ParamsFile; ParamsExisted = $global:GsFake.ParamsExisted; ParamsText = $global:GsFake.ParamsText
    ParamsRemoved = $(if ($global:GsFake.ParamsFile) { -not (Test-Path -LiteralPath $global:GsFake.ParamsFile) } else { $false })
    Polls = $global:GsFake.Polls
  }
}

function Check([string]$name, [scriptblock]$cond, $r) {
  $ok = $false
  try { $ok = [bool](& $cond) } catch { $ok = $false }
  if ($ok) { $script:Passed += 1; Write-Host "PASS  $name" }
  else {
    $script:Failed += 1
    Write-Host "FAIL  $name"
    Write-Host ("      thrown=[{0}] warnings=[{1}] host=[{2}] output=[{3}] errors=[{4}] params=[{5}] existed={6} removed={7}" -f $r.Thrown, ($r.Warnings -join ' | '), ($r.HostLines -join ' | '), ($r.Output -join ' | '), ($r.Errors -join ' | '), $r.ParamsFile, $r.ParamsExisted, $r.ParamsRemoved)
  }
}
function Cleanup-Ok($r) { $r.ParamsExisted -and $r.ParamsRemoved -and ($r.ParamsText -match '"commands":\["/opt/gs/bin/gs-health"\]') }

$NL = [Environment]::NewLine
$multi = "first stderr line`nsecond stderr line`nthird: digest pulled"
$refusedFailed = 'gs-host: REFUSED: the host command ended Failed.'
$started = "gs-host: status on $Instance (command cmd-0001)"

Write-Host "gs-host stderr regression -- PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) -- $Target"

# A. Success + no stderr (the AWS CLI prints an empty line for an empty string): exits normally, no warning.
$r = Invoke-GsHost -Status 'Success' -Stdout "healthy`nall checks ok" -Stderr ''
Check 'A  Success + no stderr: no throw, no warning, stdout unchanged, polled to completion' { -not $r.Thrown -and $r.Warnings.Count -eq 0 -and ($r.Output -join '|') -eq 'healthy|all checks ok' -and ($r.HostLines -contains $started) -and $r.Polls -eq 2 } $r
Check 'A  temp parameter file written then removed' { Cleanup-Ok $r } $r

# B. Success + one stderr line: one warning with that line; the command still succeeds.
$r = Invoke-GsHost -Status 'Success' -Stdout 'ok' -Stderr 'pulling image layer'
Check 'B  Success + one stderr line: warning emitted, no throw' { -not $r.Thrown -and $r.Warnings.Count -eq 1 -and $r.Warnings[0] -eq 'pulling image layer' -and ($r.Output -join '|') -eq 'ok' } $r
Check 'B  temp parameter file removed' { Cleanup-Ok $r } $r

# C. Success + MULTILINE stderr (the live incident): ONE warning carrying every line, and the run still succeeds.
$r = Invoke-GsHost -Status 'Success' -Stdout "GS-ARM64-LIVE-SMOKE BEGIN`nGS-ARM64-LIVE-SMOKE END exit=0" -Stderr $multi
Check 'C  Success + multiline stderr: no throw (reached the status check and passed it)' { -not $r.Thrown -and $r.Errors.Count -eq 0 } $r
Check 'C  one warning, every stderr line preserved in order' { $r.Warnings.Count -eq 1 -and $r.Warnings[0] -eq ("first stderr line${NL}second stderr line${NL}third: digest pulled") } $r
Check 'C  stdout unchanged' { ($r.Output -join '|') -eq 'GS-ARM64-LIVE-SMOKE BEGIN|GS-ARM64-LIVE-SMOKE END exit=0' } $r
Check 'C  temp parameter file removed' { Cleanup-Ok $r } $r

# D. FAILED + multiline stderr: the stderr is shown AND the wrapper ends with the explicit REFUSED.
$r = Invoke-GsHost -Status 'Failed' -Stdout 'partial output' -Stderr $multi
Check 'D  Failed + multiline stderr: REFUSED: the host command ended Failed.' { $r.Thrown -eq $refusedFailed } $r
Check 'D  the stderr was shown (one warning, all lines)' { $r.Warnings.Count -eq 1 -and $r.Warnings[0] -match 'first stderr line' -and $r.Warnings[0] -match 'third: digest pulled' } $r
Check 'D  temp parameter file removed' { Cleanup-Ok $r } $r

# D'. Other non-Success terminal states are refused too (never collapsed into success).
foreach ($s in @('TimedOut', 'Cancelled', 'Undeliverable', 'Terminated')) {
  $r = Invoke-GsHost -Status $s -Stdout '' -Stderr "x`ny"
  Check "D' $s + multiline stderr: REFUSED: the host command ended $s." { $r.Thrown -eq "gs-host: REFUSED: the host command ended $s." -and (Cleanup-Ok $r) } $r
}

# E. None / empty / whitespace StandardErrorContent: no bogus warning, either way the status decides.
foreach ($case in @(@('None', 'None'), @('empty', ''), @('blank lines', "`n  `n"))) {
  $r = Invoke-GsHost -Status 'Success' -Stdout 'ok' -Stderr $case[1]
  Check "E  Success + $($case[0]) stderr: no warning, no throw" { -not $r.Thrown -and $r.Warnings.Count -eq 0 } $r
  $r = Invoke-GsHost -Status 'Failed' -Stdout 'ok' -Stderr $case[1]
  Check "E  Failed + $($case[0]) stderr: no warning, REFUSED" { $r.Thrown -eq $refusedFailed -and $r.Warnings.Count -eq 0 } $r
}

# G. Rendering the warning can itself throw (-WarningAction Stop): the status check must STILL run.
$r = Invoke-GsHost -Status 'Failed' -Stdout '' -Stderr $multi -Extra @{ WarningAction = 'Stop' }
Check 'G  Failed + multiline stderr + -WarningAction Stop: still REFUSED: ... ended Failed.' { $r.Thrown -eq $refusedFailed } $r
Check 'G  ... and the stderr is still shown (fallback line)' { ($r.HostLines -join "`n") -match 'first stderr line' -and ($r.HostLines -join "`n") -match 'third: digest pulled' } $r
Check 'G  ... and the temp parameter file removed' { Cleanup-Ok $r } $r
$r = Invoke-GsHost -Status 'Success' -Stdout 'ok' -Stderr $multi -Extra @{ WarningAction = 'Stop' }
Check 'G  Success + multiline stderr + -WarningAction Stop: still succeeds' { -not $r.Thrown -and ($r.HostLines -join "`n") -match 'second stderr line' } $r

}
finally {
  Remove-Item -Path function:\aws.exe, function:\Start-Sleep, function:\Emit-Native -ErrorAction SilentlyContinue
  Remove-Variable -Name GsFake, GsSelf -Scope Global -ErrorAction SilentlyContinue
}
Write-Host "gs-host stderr regression: $($script:Passed) passed / $($script:Failed) failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
