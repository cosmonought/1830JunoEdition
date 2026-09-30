# LIVE-6 L6-6: run the staging certification's TASK-ROLE probe inside one ECS task (Windows PowerShell); see
# run-task-probe.sh for what it does and what it never does. A controlled, opt-in mutation: ONE standalone task, its
# command overridden to the probe and GS_STORAGE overridden to a value start.ts refuses; refused unless prerequisite.json
# is PASS for this run.
#   .\infra\aws\scripts\run-task-probe.ps1 -Environment staging -Region us-east-1 -Pool p1 -Generation 1 -Run l6cert-0930a -Out .\evidence [-DisposableWrites]
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Pool,
  [Parameter(Mandatory = $true)][string]$Generation,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$DisposableWrites
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
$prereq = Join-Path $Out "prerequisite.json"
if (-not (Test-Path $prereq)) { throw "$prereq is missing: run awsDeploy stage-cert prerequisite first; nothing was started" }
$p = Get-Content -Raw $prereq | ConvertFrom-Json
if ($p.verdict -ne "PASS" -or $p.run_id -ne $Run) { throw "$prereq is not PASS for ${Run}: nothing was started" }
$cluster = "gs-$Environment"; $service = "gs-$Environment-$Pool"
$server = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\server")
function AwsJson([string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  return ($json -join "`n")
}
$svc = (AwsJson @("ecs", "describe-services", "--cluster", $cluster, "--services", $service) | ConvertFrom-Json).services[0]
$td = $svc.taskDefinition
$net = $svc.networkConfiguration.awsvpcConfiguration
$def = (AwsJson @("ecs", "describe-task-definition", "--task-definition", $td) | ConvertFrom-Json).taskDefinition.containerDefinitions[0]
$runtime = ($def.environment | Where-Object { $_.name -eq "GS_AWS_CONFIG_PARAMETER" }).value
$logGroup = $def.logConfiguration.options."awslogs-group"
$logPrefix = $def.logConfiguration.options."awslogs-stream-prefix"
$command = @("node", "dist/server/src/tools/awsDeploy.js", "stage-probe", "task-role", "--run-id", $Run, "--runtime-parameter", $runtime, "--environment", $Environment, "--generation", $Generation, "--pool", $Pool)
if ($DisposableWrites) { $command += @("--disposable-writes", "L6CERT#$Run") }
$overrides = @{ containerOverrides = @(@{ name = "game-server"; command = $command; environment = @(@{ name = "GS_STORAGE"; value = "l6-6-probe-not-a-server" }) }) } | ConvertTo-Json -Depth 6 -Compress
$overridesFile = New-TemporaryFile
try {
  Set-Content -Path $overridesFile -Value $overrides -Encoding ascii
  $network = "awsvpcConfiguration={subnets=[$($net.subnets -join ',')],securityGroups=[$($net.securityGroups -join ',')],assignPublicIp=DISABLED}"
  $task = & aws --region $Region ecs run-task --cluster $cluster --task-definition $td --launch-type FARGATE --count 1 --started-by l6-6-cert --network-configuration $network --overrides "file://$overridesFile" --query "tasks[0].taskArn" --output text
  if ($LASTEXITCODE -ne 0) { throw "run-task failed" }
} finally {
  Remove-Item -Force $overridesFile
}
Write-Output "certifier task $task (on $td); waiting for it to stop"
& aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
if ($LASTEXITCODE -ne 0) { throw "the certifier task did not stop in time" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Set-Content -Path (Join-Path $Out "probe-task-role-run.json") -Value (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task)) -Encoding utf8
$taskId = ($task -split "/")[-1]
Set-Content -Path (Join-Path $Out "probe-task-role-log.json") -Value (AwsJson @("logs", "get-log-events", "--log-group-name", $logGroup, "--log-stream-name", "$logPrefix/game-server/$taskId", "--start-from-head")) -Encoding utf8
Push-Location $server
try {
  & node dist/server/src/tools/awsDeploy.js stage-probe collect --run-id $Run --evidence (Resolve-Path $Out)
  if ($LASTEXITCODE -ne 0) { throw "stage-probe collect failed" }
} finally {
  Pop-Location
}
