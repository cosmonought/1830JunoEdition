# LIVE-5 L5-8: the GUARANTEED no-overlap rollout for one pool (Windows PowerShell); see drain-pool.sh for why.
#   .\infra\aws\scripts\drain-pool.ps1 -Environment staging -Region us-east-1 -Pool p1 [-Evidence .\evidence -Run l6cert-0930a]
# LIVE-6 L6-6: with -Evidence (and the certification's -Run), it also records the drain for the staging certification
# (see drain-pool.sh).
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Pool,
  [string]$Evidence = "",
  [string]$Run = ""
)
$ErrorActionPreference = "Stop"
if (($Evidence -eq "") -ne ($Run -eq "")) { throw "-Evidence and -Run go together; nothing was changed" }
$cluster = "gs-$Environment"; $service = "gs-$Environment-$Pool"
function SaveJson($file, [string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  Set-Content -Path (Join-Path (Join-Path $Evidence "drain-$Pool") $file) -Value ($json -join "`n") -Encoding utf8
}
$before = @()
if ($Evidence -ne "") {
  New-Item -ItemType Directory -Force -Path (Join-Path $Evidence "drain-$Pool") | Out-Null
  $text = & aws --region $Region ecs list-tasks --cluster $cluster --service-name $service --desired-status RUNNING --query "taskArns[]" --output text
  if ($LASTEXITCODE -ne 0) { throw "list-tasks failed; nothing was changed" }
  $before = @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
  if ($before.Count -eq 0) { Set-Content -Path (Join-Path (Join-Path $Evidence "drain-$Pool") "tasks-before.json") -Value '{"tasks":[],"failures":[]}' -Encoding utf8 }
  else { SaveJson "tasks-before.json" (@("ecs", "describe-tasks", "--cluster", $cluster, "--tasks") + $before) }
}
& aws --region $Region ecs update-service --cluster $cluster --service $service --desired-count 0 --query "service.desiredCount" --output text | Out-Null
if ($LASTEXITCODE -ne 0) { throw "update-service failed" }
function TaskArns([string]$status, [string]$query) {
  $text = & aws --region $Region ecs list-tasks --cluster $cluster --service-name $service --desired-status $status --query $query --output text
  if ($LASTEXITCODE -ne 0) { throw "list-tasks failed; do not deploy" }
  return @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
}
# Listed AFTER the scale-down (see drain-pool.sh).
for ($i = 0; $i -lt 60; $i++) {
  if ((TaskArns "RUNNING" "taskArns").Count -eq 0) { break }
  Start-Sleep -Seconds 5
}
$stopping = TaskArns "STOPPED" "taskArns[:100]"
if ($stopping.Count -gt 0) {
  & aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks @stopping
  if ($LASTEXITCODE -ne 0) { throw "the tasks did not stop in time; do not deploy" }
}
if ($Evidence -ne "") {
  if ($before.Count -eq 0) { Set-Content -Path (Join-Path (Join-Path $Evidence "drain-$Pool") "tasks-after.json") -Value '{"tasks":[],"failures":[]}' -Encoding utf8 }
  else { SaveJson "tasks-after.json" (@("ecs", "describe-tasks", "--cluster", $cluster, "--tasks") + $before) }
  SaveJson "service-after.json" @("ecs", "describe-services", "--cluster", $cluster, "--services", $service)
}
$counts = & aws --region $Region ecs describe-services --cluster $cluster --services $service --query "services[0].[runningCount,pendingCount]" --output json | ConvertFrom-Json
if ($counts[0] -ne 0 -or $counts[1] -ne 0) { throw "the pool is not drained (running $($counts[0]), pending $($counts[1])); do not deploy" }
if ($Evidence -ne "") {
  $stamp = '{"format":"18COSMOS/L6-6-DRAIN/v1","run_id":"' + $Run + '","pool":"' + $Pool + '","drained_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") + '"}'
  Set-Content -Path (Join-Path (Join-Path $Evidence "drain-$Pool") "drain.json") -Value $stamp -Encoding utf8
}
Write-Output "$service drained (every task STOPPED after its graceful shutdown). Now: terraform apply (desired_count 1 starts the new task)."
