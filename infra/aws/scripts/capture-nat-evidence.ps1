# COST-2B: capture the READ-ONLY evidence that NOTHING ELSE uses the NAT gateway before its MANUAL deletion (Windows
# PowerShell). See capture-nat-evidence.sh for the files and why. This script only DESCRIBES; it deletes nothing.
#   .\infra\aws\scripts\capture-nat-evidence.ps1 -Environment staging -Region us-east-1 -NatGatewayId nat-0123456789abcdef0 `
#     -VpcId vpc-0123456789abcdef0 -TeardownAppliedAt 2026-10-05T14:00:00Z -Out .\nat-evidence
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z][a-z0-9-]{0,15}$')][string]$Environment,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z]{2}(-[a-z]+)+-[0-9]$')][string]$Region,
  [Parameter(Mandatory = $true)][ValidatePattern('^nat-[0-9a-f]{8,17}$')][string]$NatGatewayId,
  [Parameter(Mandatory = $true)][ValidatePattern('^vpc-[0-9a-f]{8,17}$')][string]$VpcId,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$')][string]$TeardownAppliedAt,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:00:00Z", $inv)
# Whole hours only: from the first whole hour at or after the teardown (CloudWatch aligns hourly buckets to the start).
$teardown = [DateTime]::ParseExact($TeardownAppliedAt, "yyyy-MM-dd'T'HH:mm:ss'Z'", $inv, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
$startTime = New-Object DateTime ($teardown.Year, $teardown.Month, $teardown.Day, $teardown.Hour, 0, 0, [DateTimeKind]::Utc)
if ($startTime -lt $teardown) { $startTime = $startTime.AddHours(1) }
$start = $startTime.ToString("yyyy-MM-ddTHH:mm:ssZ", $inv)

function Save([string]$Name, [string[]]$AwsArgs) {
  $text = & aws.exe @AwsArgs --output json
  if ($LASTEXITCODE -ne 0) { throw "aws $($AwsArgs -join ' ') failed" }
  # UTF-8 without a BOM (the judge tolerates one; the file stays byte-identical to the CLI's answer).
  [System.IO.File]::WriteAllText((Join-Path (Resolve-Path $Out) $Name), (($text -join "`n") + "`n"))
}
Save "nat-gateways.json" @("ec2", "describe-nat-gateways", "--region", $Region, "--nat-gateway-ids", $NatGatewayId)
Save "route-tables.json" @("ec2", "describe-route-tables", "--region", $Region, "--filters", "Name=vpc-id,Values=$VpcId")
Save "subnets.json" @("ec2", "describe-subnets", "--region", $Region, "--filters", "Name=vpc-id,Values=$VpcId")
Save "network-interfaces.json" @("ec2", "describe-network-interfaces", "--region", $Region, "--filters", "Name=vpc-id,Values=$VpcId")
foreach ($m in @(@("ActiveConnectionCount", "Maximum", "nat-metric-active-connections.json"), @("BytesOutToDestination", "Sum", "nat-metric-bytes-out.json"), @("BytesInFromSource", "Sum", "nat-metric-bytes-in.json"))) {
  Save $m[2] @("cloudwatch", "get-metric-statistics", "--region", $Region, "--namespace", "AWS/NATGateway", "--metric-name", $m[0], "--dimensions", "Name=NatGatewayId,Value=$NatGatewayId", "--start-time", $start, "--end-time", $now, "--period", "3600", "--statistics", $m[1])
}
$captured = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ", $inv)
$capture = '{"format":"18COSMOS/COST-2B-NAT-EVIDENCE/v1","environment":"' + $Environment + '","region":"' + $Region + '","nat_gateway_id":"' + $NatGatewayId + '","vpc_id":"' + $VpcId + '","teardown_applied_at":"' + $TeardownAppliedAt + '","metrics_start":"' + $start + '","metrics_end":"' + $now + '","captured_at":"' + $captured + '"}'
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $Out) "capture.json"), $capture + "`n")
Write-Output "NAT evidence captured in $Out (read-only; nothing deleted). Next: node dist/server/src/tools/awsDeploy.js migration-guard nat --evidence $Out"
