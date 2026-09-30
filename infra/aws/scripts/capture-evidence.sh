#!/usr/bin/env bash
# LIVE-5 L5-8 / LIVE-6 L6-2: capture the control-plane EVIDENCE `npm run awsDeploy -- verify --evidence <dir>` and
# `gamesDoctor aws flip / retire-check --evidence <dir>` check.
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
# LIVE-6 L6-2: one target group per pool; each pool's target health, stopped and running tasks (the flip's role-change
# evidence: exit codes, start times) and EVERY ACTIVE revision of its family with its tags (the rollback targets' identity
# layout, L6-4 §12.3); and a manifest stating what was captured and when (a flip preflight refuses stale evidence).
TARGET_GROUPS=()
for pool in "${POOLS[@]}"; do TARGET_GROUPS+=("gs-${ENVIRONMENT}-${pool}"); done
aws elbv2 describe-target-groups --names "${TARGET_GROUPS[@]}" > "$OUT/target-groups.json"
for pool in "${POOLS[@]}"; do
  TG_ARN="$(command aws --region "$REGION" elbv2 describe-target-groups --names "gs-${ENVIRONMENT}-${pool}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
  aws elbv2 describe-target-health --target-group-arn "$TG_ARN" > "$OUT/target-health-${pool}.json"
  for status in STOPPED RUNNING; do
    lower="$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')"
    TASKS="$(command aws --region "$REGION" ecs list-tasks --cluster "gs-${ENVIRONMENT}" --service-name "gs-${ENVIRONMENT}-${pool}" --desired-status "$status" --query 'taskArns[:100]' --output text)"
    if [ -z "$TASKS" ] || [ "$TASKS" = "None" ]; then
      echo '{"tasks":[]}' > "$OUT/${lower}-tasks-${pool}.json"
    else
      # shellcheck disable=SC2086
      aws ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks $TASKS > "$OUT/${lower}-tasks-${pool}.json"
    fi
  done
  mkdir -p "$OUT/task-definition-revisions-${pool}"
  for REVISION in $(command aws --region "$REGION" ecs list-task-definitions --family-prefix "gs-${ENVIRONMENT}-${pool}" --status ACTIVE --query 'taskDefinitionArns' --output text); do
    case "$REVISION" in
      */gs-"${ENVIRONMENT}"-"${pool}":*) aws ecs describe-task-definition --task-definition "$REVISION" --include TAGS > "$OUT/task-definition-revisions-${pool}/${REVISION##*:}.json" ;;
      *) ;; # another family sharing the prefix (gs-<env>-p1 vs gs-<env>-p10)
    esac
  done
done
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
# LIVE-6 L6-5B: this environment's CloudWatch alarms (metric and composite; the CLI follows every page) -- the verifier
# judges them against infra/aws/modules/app/alarm-contract.json.
aws cloudwatch describe-alarms --alarm-name-prefix "gs-${ENVIRONMENT}-" --alarm-types MetricAlarm CompositeAlarm > "$OUT/alarms.json"
POOL_JSON="$(printf '"%s",' "${POOLS[@]}")"
printf '{"format":"18COSMOS/EVIDENCE/v1","captured_at":"%s","environment":"%s","region":"%s","pools":[%s]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENVIRONMENT" "$REGION" "${POOL_JSON%,}" > "$OUT/manifest.json"

# LIVE-6 L6-6 (the staging certification's prerequisite): each pool's RUNNING tasks, every task in the cluster, the
# primary's target health, the distribution's own name, and when this capture was taken. Still describe/list/get only.
describe_tasks() { # <out file> <task arn>...
  local file="$1"; shift
  if [ "$#" -eq 0 ]; then echo '{"tasks":[],"failures":[]}' > "$file"; else aws ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks "$@" > "$file"; fi
}
# Each listing is captured into a variable FIRST: a failed `aws` call then stops the script (set -e), instead of
# looking like an empty list (the certification requires the cluster listing to hold every service task).
RUNNING=()
for pool in "${POOLS[@]}"; do
  LISTED="$(command aws --region "$REGION" ecs list-tasks --cluster "gs-${ENVIRONMENT}" --service-name "gs-${ENVIRONMENT}-${pool}" --desired-status RUNNING --query 'taskArns[]' --output text)"
  for arn in $LISTED; do
    [ "$arn" = "None" ] || RUNNING+=("$arn")
  done
done
describe_tasks "$OUT/running-tasks.json" "${RUNNING[@]}"
CLUSTER=()
LISTED="$(command aws --region "$REGION" ecs list-tasks --cluster "gs-${ENVIRONMENT}" --desired-status RUNNING --query 'taskArns[:100]' --output text)"
for arn in $LISTED; do
  [ "$arn" = "None" ] || CLUSTER+=("$arn")
done
describe_tasks "$OUT/cluster-tasks.json" "${CLUSTER[@]}"
# (converged with L6-2: one target group per pool, gs-<env>-<pool>; the prerequisite judges the PRIMARY pool's group)
TG_ARN="$(command aws --region "$REGION" elbv2 describe-target-groups --names "gs-${ENVIRONMENT}-${PRIMARY}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" > "$OUT/target-health.json"
aws cloudfront get-distribution --id "$DISTRIBUTION" > "$OUT/distribution.json"
# LIVE-6 L6-6 x L6-4: every ACTIVE revision of each pool's family (skip_destroy keeps them registered). INFORMATIONAL since
# L6-6R: the circuit breaker rolls back to the service's most recent COMPLETED deployment (services.json), never to "any
# ACTIVE revision"; the rollback gate judges that target's image (task definition + running tasks' digest), not this list.
for pool in "${POOLS[@]}"; do
  LISTED="$(command aws --region "$REGION" ecs list-task-definitions --family-prefix "gs-${ENVIRONMENT}-${pool}" --status ACTIVE --query 'taskDefinitionArns[]' --output text)"
  {
    printf '{"taskDefinitions":['
    SEP=""
    for arn in $LISTED; do
      [ "$arn" = "None" ] && continue
      printf '%s' "$SEP"
      command aws --region "$REGION" ecs describe-task-definition --task-definition "$arn" --query 'taskDefinition' --output json
      SEP=","
    done
    printf ']}\n'
  } > "$OUT/revisions-${pool}.json"
done
printf '{"format":"18COSMOS/L5-8-CAPTURE/v1","captured_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/capture.json"
echo "evidence written to $OUT (read-only captures; no secret is in any of them)"
