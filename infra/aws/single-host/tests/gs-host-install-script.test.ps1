# infra/aws/single-host/tests/gs-host-install-script.test.ps1 -- PHASE 1 FRESH-HOST HARDENING (runbook 13r) regression for
# gs-host.ps1's `install-script`: the remote command is built ONLY from the fixed template, the reviewed
# host-script-install.sh (base64, LF-normalised), the EXACT bytes of the checkout's host script (base64) and the validated
# name / SHA-256s; a checkout whose bytes are not the typed certified SHA-256 -- or hold a CR -- sends nothing; nothing the
# caller types can reach a shell on the host; a refused install on the host is REFUSED here.
#
# OFFLINE ONLY. No AWS, no network: `aws.exe` and `Start-Sleep` are shadowed by functions (the same fakes as
# gs-host-role-probe.test.ps1), and the test refuses to run unless `aws.exe` resolves to that fake.
#
#   Windows PowerShell 5.1:  powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\aws\single-host\tests\gs-host-install-script.test.ps1
#   PowerShell 7:            pwsh -NoProfile -File ./infra/aws/single-host/tests/gs-host-install-script.test.ps1
#   (the owner gate, run-cost2c-owner-gate.ps1, runs the first line itself on Windows: Windows PowerShell 5.1, no -Target)
#
# Exit 0 = every case passed. Without -Target it tests the gs-host.ps1 beside this tests folder; -Target runs the same
# cases against another copy of gs-host.ps1 (its host-script-install.sh and module beside it).
[CmdletBinding()]
param([ValidateNotNullOrEmpty()][string]$Target)
$ErrorActionPreference = 'Stop'
# The default is resolved HERE, never in param(): Windows PowerShell 5.1 leaves $PSScriptRoot EMPTY in an advanced script's
# parameter defaults under `powershell -File` (PowerShell/PowerShell#4688: the automatic variables are not set up before
# parameter binding), so `Split-Path -Parent $PSScriptRoot` threw before the first case. The body knows its own path.
if (-not $PSBoundParameters.ContainsKey('Target')) {
  if ([string]::IsNullOrEmpty($MyInvocation.MyCommand.Path)) { throw 'gs-host-install-script.test: REFUSED: run it as a file (-File, or & <path>), or pass -Target <gs-host.ps1>' }
  $Target = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'gs-host.ps1'
}
$Target = (Resolve-Path -LiteralPath $Target).Path
$OpsDir = Split-Path -Parent $Target
$InstallerScript = Join-Path $OpsDir 'host-script-install.sh'
$PreflightFile = [System.IO.Path]::Combine($OpsDir, '..', 'modules', 'single-host', 'files', 'bin', 'gs-preflight')
$global:GsSelf = (Get-Process -Id $PID).Path
$script:Passed = 0
$script:Failed = 0
$Instance = 'i-0123456789abcdef0'
$Replaces = 'ab' * 32

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
      if (Test-Path -LiteralPath $p) { $f.ParamsText = [System.IO.File]::ReadAllText($p) }
      $f.Comment = & $opt '--comment'
      $global:LASTEXITCODE = 0
      return 'cmd-0001'
    }
    'get-command-invocation' {
      switch (& $opt '--query') {
        'Status' { $global:LASTEXITCODE = 0; return $f.Status }
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
if ($resolved.CommandType -ne 'Function') { throw "gs-host-install-script.test: REFUSED: aws.exe resolves to $($resolved.CommandType) $($resolved.Source), not the offline fake" }

function Invoke-GsHost {
  param([string]$Status = 'Success', [string]$Stdout = 'GS-HOST-INSTALL BEGIN', [string]$Stderr = '', [hashtable]$Argv, [string]$Script = $Target)
  $global:GsFake = @{ Status = $Status; Stdout = $Stdout; Stderr = $Stderr; Calls = New-Object System.Collections.ArrayList; ParamsFile = $null; ParamsText = $null; Comment = $null }
  $records = New-Object System.Collections.ArrayList
  $thrown = $null
  try { & $Script @Argv *>&1 | ForEach-Object { [void]$records.Add($_) } } catch { $thrown = $_ }
  [pscustomobject]@{
    Thrown = $(if ($thrown) { $thrown.Exception.Message } else { $null })
    Output = @($records | Where-Object { $_ -is [string] })
    Info = @($records | ForEach-Object { [string]$_ })
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
function Sha256Hex([byte[]]$bytes) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($h.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $h.Dispose() }
}
$preflightBytes = [System.IO.File]::ReadAllBytes($PreflightFile)
$Certified = Sha256Hex $preflightBytes
function Install-Argv([hashtable]$Over = @{}) {
  $base = @{ Command = 'install-script'; InstanceId = $Instance; HostScript = 'gs-preflight'; Sha256 = $Certified; ReplacesSha256 = $Replaces }
  foreach ($k in $Over.Keys) { if ($null -eq $Over[$k]) { $base.Remove($k) } else { $base[$k] = $Over[$k] } }
  $base
}
$installerText = [System.IO.File]::ReadAllText($InstallerScript) -replace "`r`n", "`n"
$installerB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($installerText))
$contentB64 = [Convert]::ToBase64String($preflightBytes)
Write-Host "gs-host install-script regression -- PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)) -- $Target"

# I1. The remote command is exactly the fixed template: the reviewed installer, the EXACT bytes, the validated name / SHAs.
$hostOut = "GS-HOST-INSTALL BEGIN`nresult=installed`nGS-HOST-INSTALL END exit=0"
$r = Invoke-GsHost -Stdout $hostOut -Argv (Install-Argv)
$params = $(if ($r.ParamsText) { $r.ParamsText | ConvertFrom-Json } else { $null })
$remote = $(if ($params) { [string]$params.commands[0] } else { '' })
$want = "d=`$(mktemp -d) && printf %s $installerB64 | base64 -d > `$d/i && printf %s $contentB64 | base64 -d > `$d/f && bash `$d/i install gs-preflight $Certified $Replaces `$d/f; rc=`$?; rm -rf `$d; exit `$rc"
Check 'I1 install-script sends exactly the fixed template (installer, exact bytes, install, name, certified and replaced SHA-256)' { -not $r.Thrown -and $remote -eq $want } $r
Check 'I1 the bytes sent ARE the checkout file, byte for byte (never re-encoded)' { (Sha256Hex ([Convert]::FromBase64String(($remote -split ' ')[14]))) -eq $Certified } $r
Check 'I1 the installer sent is the repository file, LF-normalised' { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($remote -split ' ')[5])) -eq $installerText } $r
Check 'I1 the remote line holds no quote character and no line break' { $remote.Length -gt 0 -and $remote -notmatch "['`"\r\n]" } $r
Check 'I1 one SSM document, the 900 s execution timeout, the comment names the command' { $r.Calls[0] -match '--document-name AWS-RunShellScript' -and [string]$params.executionTimeout[0] -eq '900' -and $r.Comment -eq 'gs-host install-script' } $r
Check 'I1 the host output is passed through unchanged; temp parameter file removed' { ($r.Output -join '|') -eq ($hostOut -replace "`n", '|') -and $r.ParamsRemoved } $r

# I2. -Check: the same template in check mode (the host writes nothing).
$r = Invoke-GsHost -Argv (Install-Argv @{ Check = $true })
Check 'I2 -Check sends the check mode' { -not $r.Thrown -and (($r.ParamsText | ConvertFrom-Json).commands[0]) -match " bash \`$d/i check gs-preflight $Certified $Replaces \`$d/f; rc=" } $r

# I3. Missing arguments: REFUSED, nothing sent.
foreach ($missing in @('HostScript', 'Sha256', 'ReplacesSha256')) {
  $r = Invoke-GsHost -Argv (Install-Argv @{ $missing = $null })
  Check "I3 without -$missing`: REFUSED, nothing sent" { $r.Thrown -match '^gs-host: REFUSED: install-script needs' -and $r.Calls.Count -eq 0 } $r
}

# I4. The checkout's bytes are not the typed certified SHA-256: REFUSED before anything is sent.
$r = Invoke-GsHost -Argv (Install-Argv @{ Sha256 = $Replaces })
Check 'I4 a checkout whose bytes are not the certified SHA-256: REFUSED, nothing sent' { $r.Thrown -match "is sha256 $Certified, not the certified $Replaces" -and $r.Calls.Count -eq 0 } $r

# I5. Hostile or malformed values never reach the host.
$hostile = @(
  @{ HostScript = 'gs-run' }, @{ HostScript = '../gs-run' }, @{ HostScript = 'GS-PREFLIGHT' }, @{ HostScript = "gs-preflight`n" }, @{ HostScript = 'gs-preflight; reboot' },
  @{ Sha256 = $Certified.ToUpper() }, @{ Sha256 = "$Certified`n" }, @{ Sha256 = 'abc' }, @{ Sha256 = "$Certified;id" },
  @{ ReplacesSha256 = $Replaces.ToUpper() }, @{ ReplacesSha256 = "$Replaces`r" }, @{ ReplacesSha256 = '$(id)' }
)
foreach ($h in $hostile) {
  $r = Invoke-GsHost -Argv (Install-Argv $h)
  $label = ($h.Keys | ForEach-Object { "-$_ $($h[$_] -replace "`r", '\r' -replace "`n", '\n')" }) -join ' '
  Check "I5 $label`: refused, nothing sent" { $r.Thrown -and $r.Calls.Count -eq 0 } $r
}

# I6. A CR in the checkout's file (a non-LF checkout): REFUSED, nothing sent -- the certified bytes are LF.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('gs-host-install-' + [guid]::NewGuid().ToString('N'))
try {
  $ops = [System.IO.Path]::Combine($tmp, 'infra', 'aws', 'single-host'); $bin = [System.IO.Path]::Combine($tmp, 'infra', 'aws', 'modules', 'single-host', 'files', 'bin')
  New-Item -ItemType Directory -Force -Path $ops, $bin | Out-Null
  Copy-Item -LiteralPath $Target, $InstallerScript -Destination $ops
  $crlf = [System.Text.Encoding]::UTF8.GetBytes(([System.Text.Encoding]::UTF8.GetString($preflightBytes) -replace "`n", "`r`n"))
  [System.IO.File]::WriteAllBytes((Join-Path $bin 'gs-preflight'), $crlf)
  $r = Invoke-GsHost -Script (Join-Path $ops 'gs-host.ps1') -Argv (Install-Argv @{ Sha256 = (Sha256Hex $crlf) })
  Check 'I6 a CRLF checkout of the script: REFUSED (not the certified LF bytes), nothing sent' { $r.Thrown -match 'holds a CR' -and $r.Calls.Count -eq 0 } $r
} finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }

# I7. A refusal on the host (e.g. exit 93) ends the SSM command Failed: REFUSED here, the host's framed output shown.
$r = Invoke-GsHost -Status 'Failed' -Stdout "GS-HOST-INSTALL BEGIN`nrefused=the received bytes are not the certified ones`nGS-HOST-INSTALL END exit=93" -Stderr "line one`nline two" -Argv (Install-Argv)
Check 'I7 a refused install on the host: REFUSED: the host command ended Failed.' { $r.Thrown -eq 'gs-host: REFUSED: the host command ended Failed.' -and ($r.Output -join '|') -match 'END exit=93' -and $r.ParamsRemoved } $r

# I8. The other commands are unchanged (status still sends exactly gs-health; deploy exactly gs-deploy).
$r = Invoke-GsHost -Stdout 'ok' -Argv @{ Command = 'status'; InstanceId = $Instance }
Check 'I8 status: exactly /opt/gs/bin/gs-health' { -not $r.Thrown -and $r.ParamsText -match '"commands":\["/opt/gs/bin/gs-health"\]' } $r
$r = Invoke-GsHost -Stdout 'ok' -Argv @{ Command = 'deploy'; InstanceId = $Instance; Digest = ('sha256:' + 'cd' * 32); BuildId = 'sh1-5b4756d-arm64-r1'; Measure = $true }
Check 'I8 deploy -Measure: exactly gs-deploy <digest> <build> --measure' { -not $r.Thrown -and (($r.ParamsText | ConvertFrom-Json).commands[0]) -eq ('/opt/gs/bin/gs-deploy sha256:' + 'cd' * 32 + ' sh1-5b4756d-arm64-r1 --measure') } $r
}
finally {
  Remove-Item -Path function:\aws.exe, function:\Start-Sleep, function:\Emit-Native -ErrorAction SilentlyContinue
  Remove-Variable -Name GsFake, GsSelf -Scope Global -ErrorAction SilentlyContinue
}
Write-Host "gs-host install-script regression: $($script:Passed) passed / $($script:Failed) failed"
if ($script:Failed -gt 0) { exit 1 }
exit 0
