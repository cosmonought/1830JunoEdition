#!/usr/bin/env bash
# COST-2B: capture the READ-ONLY evidence that NOTHING ELSE uses the NAT gateway before its MANUAL deletion
# (infra/aws/SINGLE_HOST_MIGRATION.md step 23). The NAT is outside this repository's Terraform: no plan shows who
# depends on it, so its deletion is never automatically safe. This script only DESCRIBES; it deletes nothing.
#
#   infra/aws/scripts/capture-nat-evidence.sh <environment> <region> <nat gateway id> <vpc id> <teardown applied at, UTC ISO-8601> <out dir>
#   e.g. infra/aws/scripts/capture-nat-evidence.sh staging us-east-1 nat-0123456789abcdef0 vpc-0123456789abcdef0 2026-10-05T14:00:00Z ./nat-evidence
#
# <teardown applied at>: when step 20's compute-none apply finished (its guard record / the apply's own output). The
# metrics window runs from that instant until now; `awsDeploy migration-guard nat --evidence <out dir>` needs >= 24 h
# of it, all zero. Credentials: the app account's (ec2:Describe*, cloudwatch:GetMetricStatistics).
set -euo pipefail
if [ "$#" -ne 6 ]; then
  echo "usage: $0 <environment> <region> <nat gateway id> <vpc id> <teardown applied at (UTC ISO-8601)> <out dir>" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; NAT="$3"; VPC="$4"; TEARDOWN="$5"; OUT="$6"
printf '%s' "$ENVIRONMENT" | grep -Eq '^[a-z][a-z0-9-]{0,15}$' || { echo "bad environment" >&2; exit 2; }
printf '%s' "$REGION" | grep -Eq '^[a-z]{2}(-[a-z]+)+-[0-9]$' || { echo "bad region" >&2; exit 2; }
printf '%s' "$NAT" | grep -Eq '^nat-[0-9a-f]{8,17}$' || { echo "bad NAT gateway id" >&2; exit 2; }
printf '%s' "$VPC" | grep -Eq '^vpc-[0-9a-f]{8,17}$' || { echo "bad VPC id" >&2; exit 2; }
printf '%s' "$TEARDOWN" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || { echo "the teardown time is UTC ISO-8601 (YYYY-MM-DDTHH:MM:SSZ)" >&2; exit 2; }
mkdir -p "$OUT"
# The window covers WHOLE hours only: from the first whole hour at or after the teardown, to the last whole hour before
# now (CloudWatch aligns hourly buckets to the start time; a partial hour would carry the teardown's own traffic).
TEARDOWN_S="$(date -u -d "$TEARDOWN" +%s)" || { echo "this script needs GNU date (use capture-nat-evidence.ps1 on Windows)" >&2; exit 2; }
START="$(date -u -d "@$(( (TEARDOWN_S + 3599) / 3600 * 3600 ))" +%Y-%m-%dT%H:%M:%SZ)"
NOW="$(date -u +%Y-%m-%dT%H:00:00Z)"

aws ec2 describe-nat-gateways --region "$REGION" --nat-gateway-ids "$NAT" --output json > "$OUT/nat-gateways.json"
aws ec2 describe-route-tables --region "$REGION" --filters "Name=vpc-id,Values=$VPC" --output json > "$OUT/route-tables.json"
aws ec2 describe-subnets --region "$REGION" --filters "Name=vpc-id,Values=$VPC" --output json > "$OUT/subnets.json"
aws ec2 describe-network-interfaces --region "$REGION" --filters "Name=vpc-id,Values=$VPC" --output json > "$OUT/network-interfaces.json"
metric() { # <metric> <statistic> <file>
  aws cloudwatch get-metric-statistics --region "$REGION" --namespace AWS/NATGateway --metric-name "$1" \
    --dimensions "Name=NatGatewayId,Value=$NAT" --start-time "$START" --end-time "$NOW" --period 3600 --statistics "$2" \
    --output json > "$OUT/$3"
}
metric ActiveConnectionCount Maximum nat-metric-active-connections.json
metric BytesOutToDestination Sum nat-metric-bytes-out.json
metric BytesInFromSource Sum nat-metric-bytes-in.json
printf '{"format":"18COSMOS/COST-2B-NAT-EVIDENCE/v1","environment":"%s","region":"%s","nat_gateway_id":"%s","vpc_id":"%s","teardown_applied_at":"%s","metrics_start":"%s","metrics_end":"%s","captured_at":"%s"}\n' \
  "$ENVIRONMENT" "$REGION" "$NAT" "$VPC" "$TEARDOWN" "$START" "$NOW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/capture.json"
echo "NAT evidence captured in $OUT (read-only; nothing deleted). Next: npm run awsDeploy -- migration-guard nat --evidence $OUT"
