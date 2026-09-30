#!/usr/bin/env bash
# LIVE-5 L5-8: capture the control-plane EVIDENCE `npm run awsDeploy -- verify --evidence <dir>` checks.
# READ-ONLY: every command below is a describe/get (no create, update, delete or run). Runs with whatever credentials the
# AWS CLI resolves (e.g. `aws sts assume-role` into gs-<env>-bootstrap, whose policy allows exactly these reads).
#
#   infra/aws/scripts/capture-evidence.sh <environment> <region> <primary pool> <distribution id> <out dir> [<other pool> ...]
set -euo pipefail
if [ "$#" -lt 5 ]; then
  echo "usage: $0 <environment> <region> <primary pool> <distribution id> <out dir> [<other pool> ...]" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; PRIMARY="$3"; DISTRIBUTION="$4"; OUT="$5"; shift 5
POOLS=("$PRIMARY" "$@")
mkdir -p "$OUT"
aws() { command aws --region "$REGION" --output json "$@"; }

SERVICES=()
for pool in "${POOLS[@]}"; do SERVICES+=("gs-${ENVIRONMENT}-${pool}"); done
aws ecs describe-services --cluster "gs-${ENVIRONMENT}" --services "${SERVICES[@]}" > "$OUT/services.json"
# The revision each service RUNS (after a circuit-breaker rollback the family's latest revision is not the running one).
for pool in "${POOLS[@]}"; do
  RUNNING="$(command aws --region "$REGION" ecs describe-services --cluster "gs-${ENVIRONMENT}" --services "gs-${ENVIRONMENT}-${pool}" --query 'services[0].taskDefinition' --output text)"
  aws ecs describe-task-definition --task-definition "$RUNNING" > "$OUT/task-definition-${pool}.json"
done
aws elbv2 describe-target-groups --names "gs-${ENVIRONMENT}-primary" > "$OUT/target-groups.json"
LB_ARN="$(command aws --region "$REGION" elbv2 describe-load-balancers --names "gs-${ENVIRONMENT}-alb" --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$LB_ARN" > "$OUT/load-balancer-attributes.json"
LISTENER_ARN="$(command aws --region "$REGION" elbv2 describe-listeners --load-balancer-arn "$LB_ARN" --query 'Listeners[?Port==`443`] | [0].ListenerArn' --output text)"
aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" > "$OUT/listener-rules.json"
aws cloudfront get-distribution-config --id "$DISTRIBUTION" > "$OUT/distribution-config.json"
ORP_ID="$(command aws cloudfront get-distribution-config --id "$DISTRIBUTION" --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/gs*'] | [0].OriginRequestPolicyId" --output text)"
if [ -z "$ORP_ID" ] || [ "$ORP_ID" = "None" ]; then
  echo '{"OriginRequestPolicy":null}' > "$OUT/origin-request-policy.json"   # the verifier reports it
else
  aws cloudfront get-origin-request-policy --id "$ORP_ID" > "$OUT/origin-request-policy.json"
fi
aws ec2 describe-security-groups --filters "Name=group-name,Values=gs-${ENVIRONMENT}-task,gs-${ENVIRONMENT}-alb" > "$OUT/security-groups.json"
echo "evidence written to $OUT (read-only captures; no secret is in any of them)"
