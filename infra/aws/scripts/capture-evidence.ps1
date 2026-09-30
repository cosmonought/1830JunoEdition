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
# L6-6P: a capture that fails part-way must never leave an older, complete-looking set behind (see capture-evidence.sh).
foreach ($stale in @("capture.json", "cluster-tasks.json", "cluster-tasks.json.partial")) {
  $stalePath = Join-Path $Out $stale
  if (Test-Path -LiteralPath $stalePath) { Remove-Item -Force -LiteralPath $stalePath }   # a failed delete throws (Stop)
}
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
    # LIVE-6 W1: ONE whole describe-tasks answer for this bounded view, asked by task ID (see capture-evidence.sh): 100 IDs
    # stay inside cmd.exe's 8191-character line, 100 full ARNs do not.
    $ids = @($tasks | ForEach-Object { $_.Substring($_.LastIndexOf("/") + 1) })
    if ($tasks.Count -eq 0) { Set-Content -Path (Join-Path $Out $file) -Value '{"tasks":[]}' -Encoding utf8 }
    else { Save $file (@("ecs", "describe-tasks", "--cluster", "gs-$Environment", "--tasks") + $ids) }
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
$manifest = [ordered]@{ format = "18COSMOS/EVIDENCE/v1"; captured_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture); environment = $Environment; region = $Region; pools = @($pools) }
Set-Content -Path (Join-Path $Out "manifest.json") -Value ($manifest | ConvertTo-Json -Compress) -Encoding utf8

# LIVE-6 L6-6 (the staging certification's prerequisite): see capture-evidence.sh. Still describe/list/get only.
function TaskArns([string[]]$listArgs) {
  $text = & aws --region $Region ecs list-tasks --cluster "gs-$Environment" @listArgs --output text
  if ($LASTEXITCODE -ne 0) { throw "ecs list-tasks failed" }
  return @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
}
function DescribeTasks($file, [string[]]$arns) {
  if ($arns.Count -eq 0) { Set-Content -Path (Join-Path $Out $file) -Value '{"tasks":[],"failures":[]}' -Encoding utf8 }
  else { Save $file (@("ecs", "describe-tasks", "--cluster", "gs-$Environment", "--tasks") + $arns) }
}
function TaskArnsOf([string[]]$awsArgs) {
  $text = & aws --region $Region @awsArgs --output text
  if ($LASTEXITCODE -ne 0) { throw "aws $($awsArgs -join ' ') failed" }
  return @(("$text" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
}
$running = @()
foreach ($pool in $pools) { $running += TaskArns @("--service-name", "gs-$Environment-$pool", "--desired-status", "RUNNING", "--query", "taskArns[]") }
DescribeTasks "running-tasks.json" $running
# LIVE-6 L6-6 x L6-4: every ACTIVE revision of each pool's family (informational since L6-6R; see capture-evidence.sh). Captured BEFORE
# the cluster listing (L6-6P): only a few calls separate the listing from the stamp, however many revisions skip_destroy keeps.
foreach ($pool in $pools) {
  $arns = TaskArnsOf @("ecs", "list-task-definitions", "--family-prefix", "gs-$Environment-$pool", "--status", "ACTIVE", "--query", "taskDefinitionArns[]")
  $defs = @()
  foreach ($arn in $arns) {
    $json = & aws --region $Region --output json ecs describe-task-definition --task-definition $arn --query "taskDefinition"
    if ($LASTEXITCODE -ne 0) { throw "describe-task-definition failed" }
    $defs += ($json -join "`n")
  }
  Set-Content -Path (Join-Path $Out "revisions-$pool.json") -Value ('{"taskDefinitions":[' + ($defs -join ",") + ']}') -Encoding utf8
}
# LIVE-6 L6-6P: the COMPLETE cluster listing (cluster-tasks.json, 18COSMOS/L6-6P-CLUSTER-TASKS/v1): desired RUNNING and
# desired STOPPED, every list-tasks page, every distinct ARN described in batches of $describeBatch (50; see
# capture-evidence.sh -- LIVE-6 W1), each answer kept whole. Byte-for-byte the same shape as capture-evidence.sh; any
# failed call throws before the file is moved into place.
$taskArnPattern = '^arn:[a-z0-9-]+:ecs:[a-z0-9-]+:[0-9]{12}:task/[A-Za-z0-9._/-]+$'
$pageQuery = "[join('', ['T=', nextToken || '']), join(' ', taskArns)]"
$maxPages = 1000
$describeBatch = 50
$listedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
$allArns = New-Object System.Collections.Generic.List[string]
$listings = @()
foreach ($status in @("RUNNING", "STOPPED")) {
  $pages = @()
  $token = ""
  $page = 0
  while ($true) {
    if ($page -ge $maxPages) { throw "ecs list-tasks ($status): more than $maxPages pages; refusing an unbounded listing" }
    $listArgs = @("ecs", "list-tasks", "--cluster", "gs-$Environment", "--desired-status", $status, "--max-results", "100", "--no-paginate", "--query", $pageQuery, "--output", "text")
    if ($token -ne "") { $listArgs += @("--next-token", $token) }
    $lines = @(& aws --region $Region @listArgs)
    if ($LASTEXITCODE -ne 0) { throw "ecs list-tasks ($status) page $page failed" }
    if ($lines.Count -ne 1) { throw "ecs list-tasks ($status) page ${page}: $($lines.Count) lines, not one page answer" }
    $line = [string]$lines[0]
    $tab = $line.IndexOf("`t")
    if (-not $line.StartsWith("T=") -or $tab -lt 0) { throw "ecs list-tasks ($status) page ${page}: not a page answer" }
    $token = $line.Substring(2, $tab - 2)
    $pageArns = @()
    foreach ($arn in @($line.Substring($tab + 1) -split "\s+" | Where-Object { $_ -ne "" })) {
      if ($arn -cnotmatch $taskArnPattern) { throw "ecs list-tasks ($status) page ${page}: '$arn' is not a task ARN" }
      $pageArns += '"' + $arn + '"'
      $allArns.Add($arn)
    }
    $more = if ($token -ne "") { "true" } else { "false" }
    $pages += '{"page":' + $page + ',"task_arns":[' + ($pageArns -join ",") + '],"more":' + $more + '}'
    $page += 1
    if ($more -ne "true") { break }
  }
  $listings += '{"desired_status":"' + $status + '","pages":[' + ($pages -join ",") + ']}'
}
# A task whose desired status changed between the two listings appears in both: it is described (and judged) once.
$seen = New-Object System.Collections.Generic.HashSet[string]
$tasks = @($allArns | Where-Object { $seen.Add($_) })
$answers = @()
for ($i = 0; $i -lt $tasks.Count; $i += $describeBatch) {
  $batch = @($tasks[$i..([Math]::Min($i + $describeBatch - 1, $tasks.Count - 1))])
  $json = & aws --region $Region --output json ecs describe-tasks --cluster "gs-$Environment" --tasks @batch
  if ($LASTEXITCODE -ne 0) { throw "ecs describe-tasks failed (batch $($i / $describeBatch))" }
  $answers += ,($json -join "`n")
}
$partial = Join-Path $Out "cluster-tasks.json.partial"
Set-Content -Path $partial -Encoding utf8 -Value ('{"format":"18COSMOS/L6-6P-CLUSTER-TASKS/v1","cluster":"gs-' + $Environment + '","listed_at":"' + $listedAt + '","listings":[' + ($listings -join ",") + '],"task_count":' + $tasks.Count + ',"batches":[' + ($answers -join ",") + ']}')
Move-Item -Force -LiteralPath $partial -Destination (Join-Path $Out "cluster-tasks.json")
# (converged with L6-2: one target group per pool, gs-<env>-<pool>; the prerequisite judges the PRIMARY pool's group)
$tg = & aws --region $Region elbv2 describe-target-groups --names "gs-$Environment-$PrimaryPool" --query "TargetGroups[0].TargetGroupArn" --output text
if ($LASTEXITCODE -ne 0) { throw "describe-target-groups gs-$Environment-$PrimaryPool failed" }
Save "target-health.json" @("elbv2", "describe-target-health", "--target-group-arn", $tg)
Save "distribution.json" @("cloudfront", "get-distribution", "--id", $Distribution)
Set-Content -Path (Join-Path $Out "capture.json") -Value ('{"format":"18COSMOS/L5-8-CAPTURE/v1","captured_at":"' + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture) + '"}') -Encoding utf8
Write-Output "evidence written to $Out (read-only captures; no secret is in any of them)"
