# LIVE-6 L6-6 (restore drill): the OLD GENERATION'S FENCING PROBE, after the APPGEN adoption (Windows PowerShell; see
# run-restore-fence-probe.sh for the same contract). server/src/aws/runtime/restoreFenceProbe.ts is the in-task probe;
# server/src/aws/deploy/staging/restoreFencing.ts builds its overrides and records probe-restore-fencing.json. This script
# only launches ONE standalone probe task and captures ECS's record of it and its own log into <evidence dir>\restore-fence\.
#
#   .\infra\aws\scripts\run-restore-fence-probe.ps1 -Mode ledger-kms -Environment staging -Region us-east-1 -Run R -Out .\evidence -Pool p2 -PreviousGeneration 1 -Generation 2 -RestoreId drill-1002
#   .\infra\aws\scripts\run-restore-fence-probe.ps1 -Mode old-task   -Environment staging -Region us-east-1 -Run R -Out .\evidence -Pool p2 -PreviousGeneration 1 -Generation 2 -RestoreId drill-1002
#   then (after capture-evidence): node dist/server/src/tools/awsDeploy.js stage-probe restore-fencing record --run-id R `
#        --evidence <dir> --runtime-parameter <ARN> --environment staging --primary-pool <primary> --generation 2
#
# A CONTROLLED, OPT-IN PROBE, NOT A SERVER: `ecs run-task` of the pool's RUNNING task definition, the command overridden to
# the probe (never start.ts), GS_STORAGE overridden to a value start.ts refuses. The probe refuses to run unless APPGEN
# shows exactly this adoption; it writes nothing, signs nothing, takes no pool. Credentials: an operator identity (a
# profile or SSO session, never static keys); AWS CLI v2 (aws.exe).
param(
  [Parameter(Mandatory = $true)][ValidateSet("ledger-kms", "old-task")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$Pool,
  [Parameter(Mandatory = $true)][int]$PreviousGeneration,
  [Parameter(Mandatory = $true)][int]$Generation,
  [Parameter(Mandatory = $true)][string]$RestoreId
)
$ErrorActionPreference = "Stop"
if ($Run -notmatch '^[a-z0-9][a-z0-9-]{5,39}$') { throw "the run id must match ^[a-z0-9][a-z0-9-]{5,39}$" }
if ($Environment -like "prod*") { throw "the restore fencing probe never runs in a prod* environment" }
if ($Pool -notmatch '^[a-z][a-z0-9-]{0,15}$') { throw "-Pool names a pool of the deployment" }
$cluster = "gs-$Environment"
$server = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\server")
$evidence = (New-Item -ItemType Directory -Force -Path $Out).FullName
$dir = (New-Item -ItemType Directory -Force -Path (Join-Path $evidence "restore-fence")).FullName
function AwsJson([string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  return ($json -join "`n")
}
function Save($name, $text) { Set-Content -Path (Join-Path $dir $name) -Value $text -Encoding utf8 }

# An earlier attempt of this mode is moved aside (never deleted).
if (Test-Path (Join-Path $dir "$Mode-task.json")) {
  $aside = Join-Path $dir ("superseded\$Mode-" + [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ", [Globalization.CultureInfo]::InvariantCulture))
  New-Item -ItemType Directory -Force -Path $aside | Out-Null
  Get-ChildItem -Path $dir -Filter "$Mode-*.json" -File | Move-Item -Destination $aside
  Write-Output "the previous $Mode attempt moved to restore-fence\superseded\$(Split-Path -Leaf $aside)"
}
Push-Location $server
try {
  $overrides = & node dist/server/src/tools/awsDeploy.js stage-probe restore-fencing overrides --mode $Mode --run-id $Run --environment $Environment --pool $Pool --previous-generation "$PreviousGeneration" --generation "$Generation" --restore-id $RestoreId --old-game-table "gs-$Environment-game-g$PreviousGeneration"
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($code -ne 0) { throw "stage-probe restore-fencing overrides refused: $($overrides -join ' ')" }
$overridesFile = Join-Path $dir "$Mode-overrides.json"
Set-Content -Path $overridesFile -Value ($overrides -join "`n") -Encoding ascii
$svc = (AwsJson @("ecs", "describe-services", "--cluster", $cluster, "--services", "gs-$Environment-$Pool") | ConvertFrom-Json).services[0]
$td = $svc.taskDefinition
$net = $svc.networkConfiguration.awsvpcConfiguration
$def = (AwsJson @("ecs", "describe-task-definition", "--task-definition", $td) | ConvertFrom-Json).taskDefinition.containerDefinitions[0]
$logGroup = $def.logConfiguration.options."awslogs-group"
$logPrefix = $def.logConfiguration.options."awslogs-stream-prefix"
$network = "awsvpcConfiguration={subnets=[$($net.subnets -join ',')],securityGroups=[$($net.securityGroups -join ',')],assignPublicIp=DISABLED}"
$task = & aws --region $Region ecs run-task --cluster $cluster --task-definition $td --launch-type FARGATE --count 1 --started-by "l6-6-restore-fence-$Mode" --network-configuration $network --overrides "file://$overridesFile" --query "tasks[0].taskArn" --output text
if ($LASTEXITCODE -ne 0) { throw "run-task failed" }
$task = ($task -join "").Trim()
Write-Output "restore fencing probe ($Mode) task $task (on $td)"
$stream = "$logPrefix/game-server/$(($task -split '/')[-1])"
Save "$Mode-log-stream.json" ('{"log_group":"' + $logGroup + '","log_stream":"' + $stream + '"}')
& aws --region $Region ecs wait tasks-stopped --cluster $cluster --tasks $task
if ($LASTEXITCODE -ne 0) { throw "the probe task did not stop in time" }
Save "$Mode-task.json" (AwsJson @("ecs", "describe-tasks", "--cluster", $cluster, "--tasks", $task))
Save "$Mode-log.json" (AwsJson @("logs", "get-log-events", "--log-group-name", $logGroup, "--log-stream-name", $stream, "--start-from-head"))
Write-Output "PROBED: restore-fence\$Mode-task.json, $Mode-log.json (after both modes and capture-evidence: stage-probe restore-fencing record)"
