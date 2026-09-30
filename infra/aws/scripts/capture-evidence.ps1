# LIVE-5 L5-8: capture the control-plane EVIDENCE `npm run awsDeploy -- verify --evidence <dir>` checks (Windows PowerShell).
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
Save "target-groups.json" @("elbv2", "describe-target-groups", "--names", "gs-$Environment-primary")
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
Write-Output "evidence written to $Out (read-only captures; no secret is in any of them)"
