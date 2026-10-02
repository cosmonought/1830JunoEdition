# COST-2A: capture the SINGLE HOST's control-plane EVIDENCE for `awsDeploy verify --topology (coexist | single-host)`
# (Windows PowerShell twin of capture-host-evidence.sh -- same files, same rules; read its header).
# READ-ONLY: describe / get / list only, except the two OPT-INs: -HostStatus (ONE `ssm send-command` of the FIXED read-only
# /opt/gs/bin/gs-health) and -TerraformDir (`terraform output -json`, refused if any output is sensitive). Never read: an
# SSM parameter's value, a secret, the instance's user data, a budget's subscribers.
# A FAILED READ NEVER LOOKS LIKE AN EMPTY ONE: <name>.json whole, or <name>.error.json, and the run continues.
# Needs AWS CLI v2 as `aws` on PATH (as capture-evidence.ps1). Exit: 0 every read succeeded; 1 at least one failed (still written, and says which).
#
#   .\infra\aws\scripts\capture-host-evidence.ps1 -Environment staging -Region us-east-1 -InstanceId i-0123... `
#       -Distribution E123ABC -Out .\host-evidence [-HostStatus] [-TerraformDir .\infra\aws\stacks\single-host]
#   .\infra\aws\scripts\capture-host-evidence.ps1 -HostStatusOnly -Environment staging -Region us-east-1 -InstanceId i-0123... -Out .\host-evidence
param(
  [Parameter(Mandatory = $true)][string]$Environment,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [string]$Distribution = "",
  [Parameter(Mandatory = $true)][string]$Out,
  [switch]$HostStatus,
  [switch]$HostStatusOnly,
  [string]$TerraformDir = ""
)
$ErrorActionPreference = "Continue"   # every read is recorded; nothing stops the capture half-way
if ($Environment -notmatch '^[a-z][a-z0-9-]{0,31}$') { Write-Error "environment: ^[a-z][a-z0-9-]{0,31}$"; exit 2 }
if ($Region -notmatch '^[a-z]{2}(-[a-z]+)+-[0-9]$') { Write-Error "region: an AWS region"; exit 2 }
if ($InstanceId -notmatch '^(i-[0-9a-f]{8,17}|none)$') { Write-Error "instance: i-... or none"; exit 2 }
if (-not $HostStatusOnly -and $Distribution -notmatch '^[A-Z0-9]{8,20}$') { Write-Error "distribution: a CloudFront distribution id"; exit 2 }
if (($HostStatus -or $HostStatusOnly) -and $InstanceId -eq "none") { Write-Error "-HostStatus needs a host (instance id)"; exit 2 }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path -LiteralPath $Out).Path   # absolute: later steps run from other directories (terraform's)

$script:Failed = 0
$script:Calls = New-Object System.Collections.Generic.List[object]
$startedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

function Write-Utf8NoBom([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))) }
function Write-ErrorFile([string]$file, [string]$message, [int]$code) {
  $base = $file -replace '\.json$', ''
  if ($message.Length -gt 500) { $message = $message.Substring(0, 500) }
  Write-Utf8NoBom (Join-Path $Out "$base.error.json") ((@{ error = $message; exit = $code } | ConvertTo-Json -Compress) + "`n")
  $script:Calls.Add(@{ file = $file; ok = $false }); $script:Failed++
}
# Capture: the answer whole, or its failure -- never half a file, never a stale one.
function Capture([string]$file, [string[]]$awsArgs) {
  $base = $file -replace '\.json$', ''
  foreach ($stale in @($file, "$base.error.json", "$file.partial")) { $p = Join-Path $Out $stale; if (Test-Path -LiteralPath $p) { Remove-Item -Force -LiteralPath $p } }
  $errFile = New-TemporaryFile
  $json = & aws --region $Region --output json @awsArgs 2>$errFile.FullName
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Utf8NoBom (Join-Path $Out "$file.partial") (($json -join "`n") + "`n")
    Move-Item -Force -LiteralPath (Join-Path $Out "$file.partial") -Destination (Join-Path $Out $file)
    $script:Calls.Add(@{ file = $file; ok = $true })
  } else { Write-ErrorFile $file ((Get-Content -Raw -LiteralPath $errFile.FullName) -as [string]) $code }
  Remove-Item -Force -LiteralPath $errFile.FullName -ErrorAction SilentlyContinue
}
function Value([string[]]$awsArgs) { $v = & aws --region $Region --output text @awsArgs 2>$null; if ($LASTEXITCODE -ne 0) { return "" }; return ("$v").Trim() }

function Get-HostStatus {
  foreach ($stale in @("host-health.json", "host-health.error.json")) { $p = Join-Path $Out $stale; if (Test-Path -LiteralPath $p) { Remove-Item -Force -LiteralPath $p } }
  $params = New-TemporaryFile
  @{ commands = @('/opt/gs/bin/gs-health'); executionTimeout = @('120') } | ConvertTo-Json -Compress | Set-Content -Path $params -Encoding ascii
  $id = & aws --region $Region ssm send-command --instance-ids $InstanceId --document-name AWS-RunShellScript `
    --comment "capture-host-evidence gs-health" --parameters "file://$($params.FullName)" --timeout-seconds 120 --query Command.CommandId --output text 2>&1
  $code = $LASTEXITCODE
  Remove-Item -Path $params -ErrorAction SilentlyContinue
  if ($code -ne 0) { Write-ErrorFile "host-health.json" "the Run Command was refused: $id" 1; return }
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    $status = Value @("ssm", "get-command-invocation", "--command-id", "$id", "--instance-id", $InstanceId, "--query", "Status")
    if ($status -notin @("Pending", "InProgress", "Delayed", "")) { break }
  }
  Capture "host-health.json" @("ssm", "get-command-invocation", "--command-id", "$id", "--instance-id", $InstanceId)
}

if ($HostStatusOnly) {
  $manifest = Join-Path $Out "manifest.json"
  if (-not (Test-Path -LiteralPath $manifest)) { Write-Error "$Out has no manifest.json: run the full capture first"; exit 2 }
  if ((Get-Content -Raw -LiteralPath $manifest) -notmatch [regex]::Escape("`"instance_id`":`"$InstanceId`"")) { Write-Error "$Out was captured for another host"; exit 2 }
  Get-HostStatus   # the manifest is left as is; the verifier judges the directory as it is now, and the invocation's own time
  if (Test-Path -LiteralPath (Join-Path $Out "host-health.json")) { Write-Output "host status added to $Out"; exit 0 }
  Write-Error "host status FAILED (see $Out\host-health.error.json)"; exit 1
}

# Every earlier ANSWER goes first, by its evidence name only (see capture-host-evidence.sh); the snapshot comes AFTER.
$evidenceNames = @("manifest.json", "caller-identity.json", "instances.json", "instances-by-profile.json", "credit-specification.json", "termination-protection.json", "volumes.json", "image.json", "network-interfaces.json", "addresses.json", "security-groups.json", "prefix-list.json", "nat-gateways.json", "vpc-endpoints.json", "ssm-instance.json", "instance-profile.json", "role.json", "role-attached-policies.json", "role-inline-policies.json", "role-policy.json", "distribution-config.json", "origin-request-policy.json", "log-groups.json", "container-insights-log-groups.json", "alarms.json", "budgets.json", "ecs-clusters.json", "ecs-services.json", "ecs-running-tasks.json", "load-balancers.json", "target-groups.json", "host-health.json", "terraform-outputs.json", "runtime-snapshot.json")
Get-ChildItem -LiteralPath $Out -File | Where-Object {
  $n = $_.Name
  ($evidenceNames | Where-Object { $n -eq $_ -or $n -eq ($_ -replace '\.json$', '.error.json') -or $n -eq "$_.partial" }) -or $n -like "target-health-*.json"
} | Remove-Item -Force

$prefix = "gs-$Environment-"
Capture "caller-identity.json" @("sts", "get-caller-identity")
$account = Value @("sts", "get-caller-identity", "--query", "Account")
$caller = Value @("sts", "get-caller-identity", "--query", "Arn")

Capture "instances.json" @("ec2", "describe-instances", "--filters", "Name=tag:gs:environment,Values=$Environment", "Name=tag:gs:component,Values=single-host", "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped")
# ... and every instance holding the HOST ROLE's profile, tagged or not (tags can be removed; the role's authority cannot).
if ($account -match '^[0-9]{12}$') { Capture "instances-by-profile.json" @("ec2", "describe-instances", "--filters", "Name=iam-instance-profile.arn,Values=arn:aws:iam::${account}:instance-profile/${prefix}host-app", "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped") }
else { Write-ErrorFile "instances-by-profile.json" "the account could not be read (the host profile's ARN names it)" 1 }
if ($InstanceId -ne "none") {
  $pair = (Value @("ec2", "describe-instances", "--instance-ids", $InstanceId, "--query", "Reservations[0].Instances[0].[ImageId,VpcId]")) -split "\s+"
  $ami = if ($pair.Count -ge 1) { $pair[0] } else { "" }
  $vpc = if ($pair.Count -ge 2) { $pair[1] } else { "" }
  Capture "credit-specification.json" @("ec2", "describe-instance-credit-specifications", "--instance-ids", $InstanceId)
  Capture "termination-protection.json" @("ec2", "describe-instance-attribute", "--instance-id", $InstanceId, "--attribute", "disableApiTermination")
  Capture "volumes.json" @("ec2", "describe-volumes", "--filters", "Name=attachment.instance-id,Values=$InstanceId")
  if ($ami -match '^ami-[0-9a-f]+$') { Capture "image.json" @("ec2", "describe-images", "--image-ids", $ami) } else { Write-ErrorFile "image.json" "the instance's AMI could not be read" 1 }
  Capture "network-interfaces.json" @("ec2", "describe-network-interfaces", "--filters", "Name=attachment.instance-id,Values=$InstanceId")
  Capture "ssm-instance.json" @("ssm", "describe-instance-information", "--filters", "Key=InstanceIds,Values=$InstanceId")
  Capture "instance-profile.json" @("iam", "get-instance-profile", "--instance-profile-name", "${prefix}host-app")
  Capture "role.json" @("iam", "get-role", "--role-name", "${prefix}host-app")
  Capture "role-attached-policies.json" @("iam", "list-attached-role-policies", "--role-name", "${prefix}host-app")
  Capture "role-inline-policies.json" @("iam", "list-role-policies", "--role-name", "${prefix}host-app")
  Capture "role-policy.json" @("iam", "get-role-policy", "--role-name", "${prefix}host-app", "--policy-name", "gs-single-host-runtime")
}
# Every NAT gateway of the region (the verifier judges the host's VPC and the ECS era's, --legacy-vpc).
Capture "nat-gateways.json" @("ec2", "describe-nat-gateways")
Capture "vpc-endpoints.json" @("ec2", "describe-vpc-endpoints")
Capture "addresses.json" @("ec2", "describe-addresses")
Capture "security-groups.json" @("ec2", "describe-security-groups", "--filters", "Name=group-name,Values=${prefix}host,${prefix}task,${prefix}alb,${prefix}endpoints")
Capture "prefix-list.json" @("ec2", "describe-managed-prefix-lists", "--filters", "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing")

Capture "distribution-config.json" @("cloudfront", "get-distribution-config", "--id", $Distribution)
$orp = Value @("cloudfront", "get-distribution-config", "--id", $Distribution, "--query", "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/gs*'] | [0].OriginRequestPolicyId")
if ($orp -and $orp -ne "None") { Capture "origin-request-policy.json" @("cloudfront", "get-origin-request-policy", "--id", $orp) } else { Write-ErrorFile "origin-request-policy.json" "the /gs* behaviour names no origin request policy" 1 }

Capture "log-groups.json" @("logs", "describe-log-groups", "--log-group-name-prefix", "/gs/$Environment/")
Capture "container-insights-log-groups.json" @("logs", "describe-log-groups", "--log-group-name-prefix", "/aws/ecs/containerinsights/gs-$Environment/")
Capture "alarms.json" @("cloudwatch", "describe-alarms", "--alarm-name-prefix", $prefix, "--alarm-types", "MetricAlarm", "CompositeAlarm")
if ($account -match '^[0-9]{12}$') { Capture "budgets.json" @("budgets", "describe-budgets", "--account-id", $account) } else { Write-ErrorFile "budgets.json" "the account could not be read" 1 }

Capture "ecs-clusters.json" @("ecs", "describe-clusters", "--clusters", "gs-$Environment")
# Services and tasks whenever the cluster is not INACTIVE, and when that question could not be answered.
$live = Value @("ecs", "describe-clusters", "--clusters", "gs-$Environment", "--query", "length(clusters[?status!='INACTIVE'])")
if ($live -ne "0") {
  $servicesText = & aws --region $Region --output text ecs list-services --cluster "gs-$Environment" --query "serviceArns" 2>&1
  if ($LASTEXITCODE -ne 0) { Write-ErrorFile "ecs-services.json" "ecs list-services: $servicesText" 1 }
  else {
    $list = @(("$servicesText" -split "\s+") | Where-Object { $_ -ne "" -and $_ -ne "None" })
    if ($list.Count -eq 0) { Write-Utf8NoBom (Join-Path $Out "ecs-services.json") "{`"services`":[],`"failures`":[]}`n"; $script:Calls.Add(@{ file = "ecs-services.json"; ok = $true }) }
    elseif ($list.Count -gt 10) { Write-ErrorFile "ecs-services.json" "more than 10 services in gs-${Environment}: describe them by hand" 1 }
    else { Capture "ecs-services.json" (@("ecs", "describe-services", "--cluster", "gs-$Environment", "--services") + $list) }
  }
  Capture "ecs-running-tasks.json" @("ecs", "list-tasks", "--cluster", "gs-$Environment", "--desired-status", "RUNNING")
}
Capture "load-balancers.json" @("elbv2", "describe-load-balancers")
Capture "target-groups.json" @("elbv2", "describe-target-groups")
$tgText = & aws --region $Region --output text elbv2 describe-target-groups --query "TargetGroups[?starts_with(TargetGroupName, '$prefix')].[TargetGroupName,TargetGroupArn]" 2>&1
if ($LASTEXITCODE -ne 0) { Write-ErrorFile "target-health-listing.json" "elbv2 describe-target-groups: $tgText" 1 }
else {
  foreach ($line in @($tgText | ForEach-Object { "$_" -split "`r?`n" })) {   # one element per line (never "$tgText", which joins them)
    $parts = @($line.Trim() -split "\s+")
    if ($parts.Count -lt 2 -or $parts[0] -eq "" -or $parts[0] -eq "None") { continue }
    Capture "target-health-$($parts[0]).json" @("elbv2", "describe-target-health", "--target-group-arn", $parts[1])
  }
}

$hostState = "not-requested"
if ($HostStatus) { Get-HostStatus; $hostState = if (Test-Path -LiteralPath (Join-Path $Out "host-health.json")) { "captured" } else { "failed" } }
if ($TerraformDir -ne "") {
  foreach ($stale in @("terraform-outputs.json", "terraform-outputs.error.json")) { $p = Join-Path $Out $stale; if (Test-Path -LiteralPath $p) { Remove-Item -Force -LiteralPath $p } }
  Push-Location $TerraformDir
  $tfErr = New-TemporaryFile
  $tf = & terraform output -json 2>$tfErr.FullName   # stderr apart: a warning must never be written into the JSON
  $tfCode = $LASTEXITCODE
  if ($tfCode -ne 0) { $tf = Get-Content -Raw -LiteralPath $tfErr.FullName }
  Remove-Item -Force -LiteralPath $tfErr.FullName -ErrorAction SilentlyContinue
  Pop-Location
  $tfText = ($tf | ForEach-Object { "$_" }) -join "`n"
  if ($tfCode -ne 0) { Write-ErrorFile "terraform-outputs.json" "terraform output: $tfText" 1 }
  elseif ($tfText -match '"sensitive":\s*true') { Write-ErrorFile "terraform-outputs.json" "an output is marked sensitive: refused (the evidence never carries one)" 1 }
  else { Write-Utf8NoBom (Join-Path $Out "terraform-outputs.json") ($tfText + "`n"); $script:Calls.Add(@{ file = "terraform-outputs.json"; ok = $true }) }
}

$commit = "unknown"; $dirty = $false
$repo = & git -C $PSScriptRoot rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -eq 0 -and $repo) {
  $c = & git -C $repo rev-parse HEAD 2>$null; if ($LASTEXITCODE -eq 0) { $commit = "$c".Trim() }
  $dirty = [bool](& git -C $repo status --porcelain 2>$null)
}
$manifest = [ordered]@{
  format = "18COSMOS/HOST-EVIDENCE/v1"; captured_at = $startedAt; finished_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  environment = $Environment; region = $Region; account = $account; caller_arn = $caller; instance_id = $InstanceId; distribution = $Distribution
  host_status = $hostState; source_commit = $commit; source_dirty = $dirty; calls = @($script:Calls | ForEach-Object { [ordered]@{ file = $_.file; ok = $_.ok } })
}
Write-Utf8NoBom (Join-Path $Out "manifest.json.partial") (($manifest | ConvertTo-Json -Depth 4 -Compress) + "`n")
Move-Item -Force -LiteralPath (Join-Path $Out "manifest.json.partial") -Destination (Join-Path $Out "manifest.json")
if ($script:Failed -gt 0) { Write-Warning "evidence written to ${Out}: $($script:Failed) read(s) FAILED (see *.error.json; the verifier reports what they cover as NOT EVALUATED)"; exit 1 }
Write-Output "evidence written to $Out (read-only captures; no secret is in any of them)"
