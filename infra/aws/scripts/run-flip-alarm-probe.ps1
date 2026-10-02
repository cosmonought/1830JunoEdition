# LIVE-6 L6-6: the flip drill's ALARM observations (Windows PowerShell; see run-flip-alarm-probe.sh for the same contract).
# server/src/aws/deploy/staging/flipAlarmDrill.ts is the program and the judge of every phase; this script only launches
# the standalone probe tasks and captures AWS (describe-tasks, describe-alarms, describe-alarm-history) into
# <evidence dir>/flip-alarms/, with machine timestamps.
#
#   .\infra\aws\scripts\run-flip-alarm-probe.ps1 -Mode inject     -Environment staging -Region us-east-1 -Pool p1 -Run R -Out .\evidence
#   .\infra\aws\scripts\run-flip-alarm-probe.ps1 -Mode hold-start -Environment staging -Region us-east-1 -Pool p2 -Run R -Out .\evidence [-HoldSeconds 4500]
#   .\infra\aws\scripts\run-flip-alarm-probe.ps1 -Mode observe    -Environment staging -Region us-east-1 -Run R -Out .\evidence -Phase a1|during|after -Pools p1,p2 [-TimeoutSeconds 900]
#   .\infra\aws\scripts\run-flip-alarm-probe.ps1 -Mode hold-stop  -Environment staging -Region us-east-1 -Run R -Out .\evidence
#   then: node dist/server/src/tools/awsDeploy.js stage-probe flip-alarms record --run-id R --evidence <dir> --environment staging --pools p1,p2
#
# A CONTROLLED, OPT-IN MUTATION (inject, hold-start, hold-stop only): ONE standalone `ecs run-task` of the pool's running
# task definition whose command is the drill's `node -e` program (never start.ts) and whose GS_STORAGE is a value start.ts
# refuses; it takes no pool, role, routing, generation or game and never touches the escrow. inject and hold-start refuse
# unless <evidence dir>/flip-record.json's window is open now. Credentials: an operator identity that may ecs:RunTask /
# ecs:StopTask / ecs:DescribeTasks / iam:PassRole, logs:GetLogEvents and cloudwatch:DescribeAlarms /
# DescribeAlarmHistory -- a profile or SSO session, never static keys.
param(
  [Parameter(Mandatory = $true)][ValidateSet("inject", "hold-start", "hold-stop", "observe")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Pool = "",
  [string]$Phase = "",
  [string]$Pools = "",
  [int]$HoldSeconds = 4500,
  [int]$TimeoutSeconds = 900
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
if ($Environment -like "prod*") { throw "the flip alarm probe never runs in a prod* environment" }
$cluster = "gs-$Environment"
$server = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\server")
$evidence = (New-Item -ItemType Directory -Force -Path $Out).FullName
$dir = (New-Item -ItemType Directory -Force -Path (Join-Path $evidence "flip-alarms")).FullName
function AwsJson([string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  return ($json -join "`n")
}
function Save($name, $text) { Set-Content -Path (Join-Path $dir $name) -Value $text -Encoding utf8 }
function Probe([string[]]$probeArgs) {
  Push-Location $server
  try {
    $text = & node dist/server/src/tools/awsDeploy.js stage-probe flip-alarms @probeArgs
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  return @{ code = $code; text = ($text -join "`n") }
}
function NowMs() { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

if ($Mode -eq "inject" -or $Mode -eq "hold-start") {
  if ($Pool -notmatch '^[a-z][a-z0-9-]{0,15}$') { throw "-Pool names the flip pool" }
  $window = Probe @("window", "--run-id", $Run, "--evidence", $evidence)
  Write-Output $window.text
  if ($window.code -ne 0) { throw "the flip record's window is not open: nothing was started" }
  $probeMode = if ($Mode -eq "inject") { "inject" } else { "hold" }
  $startedBy = if ($Mode -eq "inject") { "l6-6-flip-alarm-a1" } else { "l6-6-flip-alarm-hold" }
  if ($Mode -eq "hold-start" -and (Test-Path (Join-Path $dir "hold-task.json"))) { throw "a hold was already started for this run (hold-task.json); stop it with -Mode hold-stop" }
  $overrideArgs = @("overrides", "--mode", $probeMode, "--environment", $Environment, "--pool", $Pool, "--run-id", $Run)
  if ($Mode -eq "hold-start") { $overrideArgs += @("--hold-seconds", "$HoldSeconds") }
  $overrides = Probe $overrideArgs
  if ($overrides.code -ne 0) { throw "stage-probe flip-alarms overrides refused: $($overrides.text)" }
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
    $task = & aws --region $Region ecs run-task --cluster $cluster --task-definition $td --launch-type FARGATE --count 1 --started-by $startedBy --network-configuration $network --overrides "file://$overridesFile" --query "tasks[0].taskArn" --output text
    if ($LASTEXITCODE -ne 0) { throw "run-task failed" }
  } finally {
    Remove-Item -Force $overridesFile
  }
  Write-Output "flip alarm probe ($probeMode) task $task (on $td)"
  if ($Mode -eq "inject") {
    & aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
    if ($LASTEXITCODE -ne 0) { throw "the inject task did not stop in time" }
    Save "inject-task.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
    $taskId = ($task -split "/")[-1]
    $stream = "$logPrefix/game-server/$taskId"
    Save "inject-log-stream.json" ('{"log_group":"' + $logGroup + '","log_stream":"' + $stream + '"}')
    Save "inject-log.json" (AwsJson @("logs", "get-log-events", "--log-group-name", $logGroup, "--log-stream-name", $stream, "--start-from-head"))
    Write-Output "INJECTED: flip-alarms/inject-task.json, inject-log.json (observe the a1 phase next)"
  } else {
    & aws --region $Region ecs wait tasks-running --cluster $cluster --tasks $task
    if ($LASTEXITCODE -ne 0) { throw "the hold task did not reach RUNNING" }
    Save "hold-task.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
    Write-Output "HOLDING: flip-alarms/hold-task.json (bounded: $HoldSeconds s; observe the during phase next)"
  }
  exit 0
}

if ($Mode -eq "hold-stop") {
  $hold = Get-Content -Raw (Join-Path $dir "hold-task.json") | ConvertFrom-Json
  $task = @($hold.tasks)[0].taskArn
  & aws --region $Region ecs stop-task --cluster $cluster --task $task --reason "l6-6 flip alarm drill: hold-stop" --query "task.taskArn" --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "stop-task failed" }
  & aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
  if ($LASTEXITCODE -ne 0) { throw "the hold task did not stop in time" }
  Save "hold-task-stopped.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
  Write-Output "HOLD STOPPED: flip-alarms/hold-task-stopped.json"
  exit 0
}

# observe: capture, judge the phase, poll while NOT YET (exit 10), stop on OBSERVED (0) or REFUSED.
if ($Phase -notin @("a1", "during", "after")) { throw "-Phase is a1, during or after" }
if ($Pools -eq "") { throw "-Pools names the deployment's pools (comma-separated)" }
$deadline = (NowMs) + 1000 * $TimeoutSeconds
while ($true) {
  $from = NowMs
  Save "raw-$Phase-alarms.json" (AwsJson @("cloudwatch", "describe-alarms", "--alarm-name-prefix", "gs-$Environment-", "--alarm-types", "MetricAlarm", "CompositeAlarm"))
  if ($Phase -eq "a1") { Save "raw-a1-history.json" (AwsJson @("cloudwatch", "describe-alarm-history", "--alarm-name", "gs-$Environment-a1-unexpected-task-loss", "--history-item-type", "StateUpdate", "--max-records", "100")) }
  $to = NowMs
  Save "raw-$Phase-stamp.json" ('{"captured_from":' + $from + ',"captured_to":' + $to + '}')
  $answer = Probe @("observe", "--run-id", $Run, "--evidence", $evidence, "--environment", $Environment, "--pools", $Pools, "--phase", $Phase)
  Write-Output $answer.text
  if ($answer.code -eq 0) { exit 0 }
  if ($answer.code -ne 10) { throw "the $Phase phase was refused" }
  if ((NowMs) -gt $deadline) { throw "the $Phase phase was not observed within $TimeoutSeconds s" }
  Start-Sleep -Seconds 20
}
