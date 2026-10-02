# LIVE-6 L6-6 (restore drill): the restore alarms' ALARM-PIPELINE INJECTION (Windows PowerShell; see run-restore-alarm-probe.sh
# for the same contract). server/src/aws/deploy/staging/restoreAlarmProbe.ts is the probe program and the derivation of every
# case; restoreAlarmDrill.ts the precheck and the record. This script only launches the standalone probe tasks and captures
# AWS (describe-alarms, describe-tasks, the task's log, describe-alarm-history) into <evidence dir>\restore-alarms\, with
# machine timestamps.
#
#   .\infra\aws\scripts\run-restore-alarm-probe.ps1 -Mode inject     -Environment staging -Region us-east-1 -Run R -Out .\evidence -Case r1 -Pool p1 -Pools p1,p2 [-Overlap] [-TimeoutSeconds 600]
#   .\infra\aws\scripts\run-restore-alarm-probe.ps1 -Mode hold-start -Environment staging -Region us-east-1 -Run R -Out .\evidence -Case r3 -Pool p2 -Pools p1,p2 [-HoldSeconds 4500]
#   .\infra\aws\scripts\run-restore-alarm-probe.ps1 -Mode observe    -Environment staging -Region us-east-1 -Run R -Out .\evidence -Case r1 [-TimeoutSeconds 900]
#   .\infra\aws\scripts\run-restore-alarm-probe.ps1 -Mode hold-stop  -Environment staging -Region us-east-1 -Run R -Out .\evidence
#   then: node dist/server/src/tools/awsDeploy.js stage-probe restore-alarms record --run-id R --evidence <dir> --environment staging --pools p1,p2
#
# AN ALARM-PIPELINE INJECTION, NOT A FAULT: one standalone `ecs run-task` of the pool's running task definition whose command
# is the drill's `node -e` program over the image's own runtimeMetrics encoder (never start.ts) and whose GS_STORAGE is a
# value start.ts refuses. It takes no pool, role, routing, generation or game, touches no APPGEN, identity restore state or
# journal, and never the escrow. The task is started only after `stage-probe restore-alarms precheck` cleared it. -Pools is
# one comma-separated string (it is the same whether the script is run inside a PowerShell session or with -File).
# Credentials: an operator identity (a profile or SSO session, never static keys); AWS CLI v2 (aws.exe).
param(
  [Parameter(Mandatory = $true)][ValidateSet("inject", "hold-start", "hold-stop", "observe")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Case = "",
  [string]$Pool = "",
  [string]$Pools = "",
  [switch]$Overlap,
  [int]$HoldSeconds = 4500,
  [int]$TimeoutSeconds = 0
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
if ($Environment -like "prod*") { throw "the restore alarm probe never runs in a prod* environment" }
$cluster = "gs-$Environment"
$server = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\server")
$evidence = (New-Item -ItemType Directory -Force -Path $Out).FullName
$dir = (New-Item -ItemType Directory -Force -Path (Join-Path $evidence "restore-alarms")).FullName
function AwsJson([string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  return ($json -join "`n")
}
function Save($name, $text) { Set-Content -Path (Join-Path $dir $name) -Value $text -Encoding utf8 }
function Probe([string[]]$probeArgs) {
  Push-Location $server
  try {
    $text = & node dist/server/src/tools/awsDeploy.js stage-probe restore-alarms @probeArgs
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return @{ code = $code; text = ($text -join "`n") }
}
function NowMs() { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function ReadJson($name) { return (Get-Content -Raw (Join-Path $dir $name)) -replace "^﻿", "" | ConvertFrom-Json }

if ($Mode -eq "inject" -or $Mode -eq "hold-start") {
  if ($Mode -eq "inject" -and $Case -notin @("r1", "a4g", "a4i", "r2")) { throw "-Mode inject takes -Case r1, a4g, a4i or r2 (R3 is a hold: -Mode hold-start -Case r3)" }
  if ($Mode -eq "hold-start" -and $Case -ne "r3") { throw "-Mode hold-start takes -Case r3 only" }
  if ($Mode -eq "hold-start" -and $Overlap) { throw "R3's hold lasts more than an hour: the overlap is shown with a counter case" }
  if ($Mode -eq "hold-start" -and (Test-Path (Join-Path $dir "r3-task.json"))) { throw "an r3 hold was already started for this run (restore-alarms\r3-task.json); stop it with -Mode hold-stop" }
  if ($Pool -notmatch '^[a-z][a-z0-9-]{0,15}$') { throw "-Pool names a pool of the deployment" }
  if ($Pools -eq "") { throw "-Pools names the deployment's pools (comma-separated)" }
  $timeout = if ($TimeoutSeconds -gt 0) { $TimeoutSeconds } else { 600 }
  $deadline = (NowMs) + 1000 * $timeout
  while ($true) {
    $from = NowMs
    Save "raw-$Case-pre-alarms.json" (AwsJson @("cloudwatch", "describe-alarms", "--alarm-name-prefix", "gs-$Environment-", "--alarm-types", "MetricAlarm", "CompositeAlarm"))
    $to = NowMs
    Save "raw-$Case-pre-stamp.json" ('{"captured_from":' + $from + ',"captured_to":' + $to + '}')
    $pcArgs = @("precheck", "--run-id", $Run, "--evidence", $evidence, "--environment", $Environment, "--pools", $Pools, "--case", $Case, "--pool", $Pool)
    if ($Overlap) { $pcArgs += "--overlap" }
    $answer = Probe $pcArgs
    Write-Output $answer.text
    if ($answer.code -eq 0) { break }
    if ($answer.code -ne 10) { throw "the precheck refused: nothing was started" }
    if ((NowMs) -gt $deadline) { throw "the precheck did not clear within $timeout s: nothing was started" }
    Start-Sleep -Seconds 20
  }
  $overrideArgs = @("overrides", "--case", $Case, "--environment", $Environment, "--pool", $Pool, "--run-id", $Run)
  if ($Mode -eq "hold-start") { $overrideArgs += @("--hold-seconds", "$HoldSeconds") }
  $overrides = Probe $overrideArgs
  if ($overrides.code -ne 0) { throw "stage-probe restore-alarms overrides refused: $($overrides.text)" }
  $svc = (AwsJson @("ecs", "describe-services", "--cluster", $cluster, "--services", "gs-$Environment-$Pool") | ConvertFrom-Json).services[0]
  $td = $svc.taskDefinition
  $net = $svc.networkConfiguration.awsvpcConfiguration
  $def = (AwsJson @("ecs", "describe-task-definition", "--task-definition", $td) | ConvertFrom-Json).taskDefinition.containerDefinitions[0]
  $logGroup = $def.logConfiguration.options."awslogs-group"
  $logPrefix = $def.logConfiguration.options."awslogs-stream-prefix"
  $overridesFile = New-TemporaryFile
  try {
    Set-Content -Path $overridesFile -Value $overrides.text -Encoding ascii
    $network = "awsvpcConfiguration={subnets=[$($net.subnets -join ',')],securityGroups=[$($net.securityGroups -join ',')],assignPublicIp=DISABLED}"
    $task = & aws --region $Region ecs run-task --cluster $cluster --task-definition $td --launch-type FARGATE --count 1 --started-by "l6-6-restore-alarm-$Case" --network-configuration $network --overrides "file://$overridesFile" --query "tasks[0].taskArn" --output text
    if ($LASTEXITCODE -ne 0) { throw "run-task failed" }
  } finally {
    Remove-Item -Force $overridesFile
  }
  $task = ($task -join "").Trim()
  Write-Output "restore alarm probe ($Case) task $task (on $td): an alarm-pipeline injection"
  $stream = "$logPrefix/game-server/$(($task -split '/')[-1])"
  Save "$Case-log-stream.json" ('{"log_group":"' + $logGroup + '","log_stream":"' + $stream + '"}')
  if ($Mode -eq "inject") {
    & aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
    if ($LASTEXITCODE -ne 0) { throw "the probe task did not stop in time" }
    Save "$Case-task.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
    Save "$Case-log.json" (AwsJson @("logs", "get-log-events", "--log-group-name", $logGroup, "--log-stream-name", $stream, "--start-from-head"))
    Write-Output "INJECTED: restore-alarms\$Case-task.json, $Case-log.json (observe $Case next)"
  } else {
    & aws --region $Region ecs wait tasks-running --cluster $cluster --tasks $task
    if ($LASTEXITCODE -ne 0) { throw "the hold task did not reach RUNNING" }
    Save "r3-task.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
    Write-Output "HOLDING: restore-alarms\r3-task.json (bounded by its own hold; R3 needs sixty one-minute periods: observe r3 with -TimeoutSeconds 5400)"
  }
  exit 0
}

if ($Mode -eq "hold-stop") {
  $task = @((ReadJson "r3-task.json").tasks)[0].taskArn
  if (-not $task) { throw "restore-alarms\r3-task.json names no task" }
  & aws --region $Region ecs stop-task --cluster $cluster --task $task --reason "l6-6 restore alarm drill: hold-stop" --query "task.taskArn" --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "stop-task failed" }
  & aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
  if ($LASTEXITCODE -ne 0) { throw "the hold task did not stop in time" }
  Save "r3-task-stopped.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
  Write-Output "HOLD STOPPED: restore-alarms\r3-task-stopped.json"
  exit 0
}

# observe: capture, derive the case, poll while NOT YET (exit 10), stop on OBSERVED (0) or REFUSED.
if ($Case -notin @("r1", "a4g", "a4i", "r2", "r3")) { throw "-Case is r1, a4g, a4i, r2 or r3" }
if (-not (Test-Path (Join-Path $dir "$Case-launch.json"))) { throw "no restore-alarms\$Case-launch.json: inject (or hold-start) first" }
$launch = ReadJson "$Case-launch.json"
$timeout = if ($TimeoutSeconds -gt 0) { $TimeoutSeconds } else { 900 }
$deadline = (NowMs) + 1000 * $timeout
while ($true) {
  $from = NowMs
  Save "raw-$Case-alarms.json" (AwsJson @("cloudwatch", "describe-alarms", "--alarm-name-prefix", "gs-$Environment-", "--alarm-types", "MetricAlarm", "CompositeAlarm"))
  Save "raw-$Case-history.json" (AwsJson @("cloudwatch", "describe-alarm-history", "--alarm-name", $launch.alarm, "--history-item-type", "StateUpdate"))
  if ($launch.overlap -eq $true) {
    $parts = @()
    foreach ($p in @((ReadJson "suppression-window.json").pools)) {
      $parts += ('"' + $p + '":' + (AwsJson @("cloudwatch", "describe-alarm-history", "--alarm-name", "gs-$Environment-$p-flip-window", "--history-item-type", "StateUpdate")))
    }
    Save "raw-$Case-suppressor-history.json" ("{" + ($parts -join ",") + "}")
  }
  if ($Case -eq "r3") {
    $where = ReadJson "r3-log-stream.json"
    Save "r3-log.json" (AwsJson @("logs", "get-log-events", "--log-group-name", $where.log_group, "--log-stream-name", $where.log_stream, "--start-from-head", "--limit", "50"))
  }
  $to = NowMs
  Save "raw-$Case-stamp.json" ('{"captured_from":' + $from + ',"captured_to":' + $to + '}')
  $answer = Probe @("observe", "--run-id", $Run, "--evidence", $evidence, "--environment", $Environment, "--case", $Case)
  Write-Output $answer.text
  if ($answer.code -eq 0) { exit 0 }
  if ($answer.code -ne 10) { throw "the $Case case was refused" }
  if ((NowMs) -gt $deadline) { throw "the $Case case was not observed within $timeout s" }
  Start-Sleep -Seconds 30
}
