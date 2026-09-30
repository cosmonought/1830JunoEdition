# LIVE-5 L5-8 / LIVE-6 L6-2: capture the control-plane EVIDENCE `awsDeploy verify` and `gamesDoctor aws flip / retire-check`
# check (Windows PowerShell).
# READ-ONLY: every command below is a describe/get. Runs with whatever credentials the AWS CLI resolves.
#
#   .\infra\aws\scripts\capture-evidence.ps1 -Environment staging -Region us-east-1 -PrimaryPool p1 -Distribution E123 -Out .\evidence [-OtherPools p2]
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$PrimaryPool,
  [Parameter(Mandatory = $true)][string]$Distribution,
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$OtherPools = @()
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
function Save($file, [string[]]$awsArgs) {
  $json = & aws --region $Region --output json @awsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  Set-Content -Path (Join-Path $Out $file) -Value ($json -join "`n") -Encoding utf8
}
$pools = @($PrimaryPool) + $OtherPools
$services = @($pools | ForEach-Object { "gs-$Environment-$_" })
Save "services.json" (@("ecs", "describe-services", "--cluster", "gs-$Environment", "--services") + $services)
# The revision each service RUNS (after a circuit-breaker rollback the family's latest revision is not the running one).
foreach ($pool in $pools) {
  $running = & aws --region $Region ecs describe-services --cluster "gs-$Environment" --services "gs-$Environment-$pool" --query "services[0].taskDefinition" --output text
  Save "task-definition-$pool.json" @("ecs", "describe-task-definition", "--task-definition", $running)
}
# LIVE-6 L6-2: one target group per pool; each pool's target health, stopped and running tasks, every ACTIVE revision of
# its family with its tags (the rollback targets), and a manifest (see capture-evidence.sh).
Save "target-groups.json" (@("elbv2", "describe-target-groups", "--names") + @($pools | ForEach-Object { "gs-$Environment-$_" }))
foreach ($pool in $pools) {
  $tg = & aws --region $Region elbv2 describe-target-groups --names "gs-$Environment-$pool" --query "TargetGroups[0].TargetGroupArn" --output text
  if ($LASTEXITCODE -ne 0) { throw "describe-target-groups gs-$Environment-$pool failed" }
  Save "target-health-$pool.json" @("elbv2", "describe-target-health", "--target-group-arn", $tg)
  foreach ($status in @("STOPPED", "RUNNING")) {
    $text = & aws --region $Region ecs list-tasks --cluster "gs-$Environment" --service-name "gs-$Environment-$pool" --desired-status $status --query "taskArns[:100]" --output text
    if ($LASTEXITCODE -ne 0) { throw "list-tasks failed" }
    $tasks = @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
    $file = "$($status.ToLower())-tasks-$pool.json"
    if ($tasks.Count -eq 0) { Set-Content -Path (Join-Path $Out $file) -Value '{"tasks":[]}' -Encoding utf8 }
    else { Save $file (@("ecs", "describe-tasks", "--cluster", "gs-$Environment", "--tasks") + $tasks) }
  }
  $revDir = Join-Path $Out "task-definition-revisions-$pool"
  New-Item -ItemType Directory -Force -Path $revDir | Out-Null
  $revText = & aws --region $Region ecs list-task-definitions --family-prefix "gs-$Environment-$pool" --status ACTIVE --query "taskDefinitionArns" --output text
  if ($LASTEXITCODE -ne 0) { throw "list-task-definitions failed" }
  foreach ($revision in @(("$revText" -split "\s+") | Where-Object { $_ -match "/gs-$Environment-${pool}:[0-9]+$" })) {
    $number = $revision.Substring($revision.LastIndexOf(":") + 1)
    Save (Join-Path "task-definition-revisions-$pool" "$number.json") @("ecs", "describe-task-definition", "--task-definition", $revision, "--include", "TAGS")
  }
}
$lb = & aws --region $Region elbv2 describe-load-balancers --names "gs-$Environment-alb" --query "LoadBalancers[0].LoadBalancerArn" --output text
Save "load-balancer-attributes.json" @("elbv2", "describe-load-balancer-attributes", "--load-balancer-arn", $lb)
$listener = & aws --region $Region elbv2 describe-listeners --load-balancer-arn $lb --query "Listeners[?Port==``443``] | [0].ListenerArn" --output text
Save "listener-rules.json" @("elbv2", "describe-rules", "--listener-arn", $listener)
Save "distribution-config.json" @("cloudfront", "get-distribution-config", "--id", $Distribution)
$orp = & aws cloudfront get-distribution-config --id $Distribution --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/gs*'] | [0].OriginRequestPolicyId" --output text
if ([string]::IsNullOrEmpty($orp) -or $orp -eq "None") {
  Set-Content -Path (Join-Path $Out "origin-request-policy.json") -Value '{"OriginRequestPolicy":null}' -Encoding utf8
} else {
  Save "origin-request-policy.json" @("cloudfront", "get-origin-request-policy", "--id", $orp)
}
Save "security-groups.json" @("ec2", "describe-security-groups", "--filters", "Name=group-name,Values=gs-$Environment-task,gs-$Environment-alb")
# LIVE-6 L6-5B: this environment's CloudWatch alarms (metric and composite) for the verifier's alarm contract.
Save "alarms.json" @("cloudwatch", "describe-alarms", "--alarm-name-prefix", "gs-$Environment-", "--alarm-types", "MetricAlarm", "CompositeAlarm")
$manifest = [ordered]@{ format = "18COSMOS/EVIDENCE/v1"; captured_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"); environment = $Environment; region = $Region; pools = @($pools) }
Set-Content -Path (Join-Path $Out "manifest.json") -Value ($manifest | ConvertTo-Json -Compress) -Encoding utf8
Write-Output "evidence written to $Out (read-only captures; no secret is in any of them)"
