# LIVE-6 L6-6 x L6-4: capture the RESTORE DRILL's stop (Windows PowerShell); read-only. See capture-restore-stop.sh.
#   .\infra\aws\scripts\capture-restore-stop.ps1 -Environment staging -Region us-east-1 -Run l6cert-0930a -Out .\evidence -Pools p1,p2
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string[]]$Pools
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
$dir = Join-Path $Out "restore-stop"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$services = @($Pools | ForEach-Object { "gs-$Environment-$_" })
$json = & aws --region $Region --output json ecs describe-services --cluster "gs-$Environment" --services @services
if ($LASTEXITCODE -ne 0) { throw "describe-services failed" }
Set-Content -Path (Join-Path $dir "services.json") -Value ($json -join "`n") -Encoding utf8
$text = & aws --region $Region ecs list-tasks --cluster "gs-$Environment" --desired-status RUNNING --query "taskArns[:100]" --output text
if ($LASTEXITCODE -ne 0) { throw "list-tasks failed" }
$tasks = @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
if ($tasks.Count -eq 0) { Set-Content -Path (Join-Path $dir "cluster-tasks.json") -Value '{"tasks":[],"failures":[]}' -Encoding utf8 }
else {
  $json = & aws --region $Region --output json ecs describe-tasks --cluster "gs-$Environment" --tasks @tasks
  if ($LASTEXITCODE -ne 0) { throw "describe-tasks failed" }
  Set-Content -Path (Join-Path $dir "cluster-tasks.json") -Value ($json -join "`n") -Encoding utf8
}
Set-Content -Path (Join-Path $dir "stamp.json") -Value ('{"format":"18COSMOS/L6-6-RESTORE-STOP/v1","run_id":"' + $Run + '","captured_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") + '"}') -Encoding utf8
Write-Output "restore stop captured in $dir (read-only; now, and only if every service is at zero, appgen-adopt)"
