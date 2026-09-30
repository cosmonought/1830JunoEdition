# LIVE-6 L6-6 x L6-4: capture the RESTORE DRILL's stop (Windows PowerShell); read-only. See capture-restore-stop.sh
# (L6-6R: the restore id appgen-adopt will name; desired-RUNNING AND desired-STOPPED tasks, batched, nothing truncated).
#   .\infra\aws\scripts\capture-restore-stop.ps1 -Environment staging -Region us-east-1 -Run l6cert-0930a -RestoreId drill-0930 -Out .\evidence -Pools p1,p2
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$RestoreId,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string[]]$Pools
)
$ErrorActionPreference = "Stop"
if ($Run -cnotmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
if ($RestoreId -cnotmatch '^[a-z0-9][a-z0-9-]{2,63}$') { throw "the restore id must match ^[a-z0-9][a-z0-9-]{2,63}$ (the one appgen-adopt will name)" }
$dir = Join-Path $Out "restore-stop"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$services = @($Pools | ForEach-Object { "gs-$Environment-$_" })
$json = & aws --region $Region --output json ecs describe-services --cluster "gs-$Environment" --services @services
if ($LASTEXITCODE -ne 0) { throw "describe-services failed" }
Set-Content -Path (Join-Path $dir "services.json") -Value ($json -join "`n") -Encoding utf8
$tasks = @()
foreach ($status in @("RUNNING", "STOPPED")) {
  $text = & aws --region $Region ecs list-tasks --cluster "gs-$Environment" --desired-status $status --query "taskArns[]" --output text
  if ($LASTEXITCODE -ne 0) { throw "list-tasks ($status) failed" }
  $tasks += @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
}
# One describe-tasks answer per batch of 100, each kept WHOLE (its tasks and failures from the same call): {"batches":[...]}.
$answers = @()
for ($i = 0; $i -lt $tasks.Count; $i += 100) {
  $batch = $tasks[$i..([Math]::Min($i + 99, $tasks.Count - 1))]
  $json = & aws --region $Region --output json ecs describe-tasks --cluster "gs-$Environment" --tasks @batch
  if ($LASTEXITCODE -ne 0) { throw "describe-tasks failed" }
  $answers += ,($json -join "`n")
}
Set-Content -Path (Join-Path $dir "cluster-tasks.json") -Value ('{"batches":[' + ($answers -join ",") + ']}') -Encoding utf8
Set-Content -Path (Join-Path $dir "stamp.json") -Value ('{"format":"18COSMOS/L6-6-RESTORE-STOP/v2","run_id":"' + $Run + '","restore_id":"' + $RestoreId + '","captured_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) + '"}') -Encoding utf8
Write-Output "restore stop captured in $dir (read-only; now, and only if every service is at zero and every task STOPPED, appgen-adopt --restore-id $RestoreId)"
