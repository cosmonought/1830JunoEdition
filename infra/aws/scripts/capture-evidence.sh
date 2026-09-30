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
# L6-6P: a capture that fails part-way must never leave an older, complete-looking set behind: the stamp (written last)
# and the cluster listing go first, so a failed run leaves no capture.json and the certification refuses it.
rm -f "$OUT/capture.json" "$OUT/cluster-tasks.json" "$OUT/cluster-tasks.json.partial"
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
      # LIVE-6 W1: this bounded view (the first 100) stays ONE whole describe-tasks answer, asked by task ID (the ARN's
      # last segment; DescribeTasks takes IDs or ARNs with --cluster): 100 IDs are ~3.3k characters, inside cmd.exe's
      # 8191-character line (an `aws.cmd`), where 100 full ARNs (~8.4k) are not. The answer names every task by its ARN.
      IDS=()
      for arn in $TASKS; do IDS+=("${arn##*/}"); done
      aws ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks "${IDS[@]}" > "$OUT/${lower}-tasks-${pool}.json"
    fi
  done
  mkdir -p "$OUT/task-definition-revisions-${pool}"
  # Captured into a variable FIRST (converged with L6-6's rule): a failed listing stops the script (set -e) instead of
  # looking like a family with no ACTIVE revision.
  REVISIONS="$(command aws --region "$REGION" ecs list-task-definitions --family-prefix "gs-${ENVIRONMENT}-${pool}" --status ACTIVE --query 'taskDefinitionArns' --output text)"
  for REVISION in $REVISIONS; do
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

# LIVE-6 L6-6 (the staging certification's prerequisite): each pool's RUNNING tasks, every task in the cluster (L6-6P), the
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
# (an empty array expanded safely: bash < 4.4 treats "${RUNNING[@]}" as unbound under set -u -- every pool drained)
describe_tasks "$OUT/running-tasks.json" "${RUNNING[@]+"${RUNNING[@]}"}"
# LIVE-6 L6-6 x L6-4: every ACTIVE revision of each pool's family (skip_destroy keeps them registered). INFORMATIONAL since
# L6-6R: the circuit breaker rolls back to the service's most recent COMPLETED deployment (services.json), never to "any
# ACTIVE revision"; the rollback gate judges that target's image (task definition + running tasks' digest), not this list.
# Captured BEFORE the cluster listing (L6-6P): only a few calls separate the listing from the stamp, however many revisions
# skip_destroy keeps.
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
# LIVE-6 L6-6P: the COMPLETE cluster listing (cluster-tasks.json, format 18COSMOS/L6-6P-CLUSTER-TASKS/v1). Every task
# whose desired status is RUNNING and every task whose desired status is STOPPED (a task draining under SIGTERM has
# desired STOPPED and is still running; ECS never sets a desired status of PENDING), EVERY `list-tasks` page (100 per
# page, followed by its next token until there is none), then every distinct ARN described in batches of DESCRIBE_BATCH
# (50: DescribeTasks takes up to 100, but 100 full ARNs are ~8.4k characters -- past cmd.exe's 8191-character line when
# the CLI is an `aws.cmd`; 50 are ~4.2k -- LIVE-6 W1; the certification judges 1-100 per batch), each
# `describe-tasks` answer kept WHOLE (its tasks and its failures from the same call). Nothing is cut: any failed call stops
# the script (set -e) and the file is only moved into place once complete. The certification re-derives completeness
# from the file (page chain, task_count, every ARN described exactly once, no failure) and refuses anything less.
TASK_ARN_RE='^arn:[a-z0-9-]+:ecs:[a-z0-9-]+:[0-9]{12}:task/[A-Za-z0-9._/-]+$'
PAGE_QUERY="[join('', ['T=', nextToken || '']), join(' ', taskArns)]"
MAX_PAGES=1000
DESCRIBE_BATCH=50
LISTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ALL_ARNS=()
LISTINGS=""
for status in RUNNING STOPPED; do
  PAGES=""; TOKEN=""; PAGE=0
  while :; do
    if [ "$PAGE" -ge "$MAX_PAGES" ]; then echo "ecs list-tasks ($status): more than $MAX_PAGES pages; refusing an unbounded listing" >&2; exit 1; fi
    LIST_ARGS=(ecs list-tasks --cluster "gs-${ENVIRONMENT}" --desired-status "$status" --max-results 100 --no-paginate --query "$PAGE_QUERY" --output text)
    if [ -n "$TOKEN" ]; then LIST_ARGS+=(--next-token "$TOKEN"); fi
    LINE="$(command aws --region "$REGION" "${LIST_ARGS[@]}")"
    case "$LINE" in
      T=*$'\t'*) ;;
      *) echo "ecs list-tasks ($status) page $PAGE: not a page answer" >&2; exit 1 ;;
    esac
    case "$LINE" in *$'\n'*) echo "ecs list-tasks ($status) page $PAGE: more than one line" >&2; exit 1 ;; esac
    HEAD="${LINE%%$'\t'*}"; TOKEN="${HEAD#T=}"
    PAGE_ARNS=""; SEP=""
    read -r -a PAGE_LIST <<< "${LINE#*$'\t'}"
    for arn in "${PAGE_LIST[@]+"${PAGE_LIST[@]}"}"; do
      if ! [[ "$arn" =~ $TASK_ARN_RE ]]; then echo "ecs list-tasks ($status) page $PAGE: '$arn' is not a task ARN" >&2; exit 1; fi
      PAGE_ARNS+="$SEP\"$arn\""; SEP=","
      ALL_ARNS+=("$arn")
    done
    if [ -n "$TOKEN" ]; then MORE=true; else MORE=false; fi
    [ -z "$PAGES" ] || PAGES+=","
    PAGES+="{\"page\":$PAGE,\"task_arns\":[$PAGE_ARNS],\"more\":$MORE}"
    PAGE=$((PAGE + 1))
    [ "$MORE" = true ] || break
  done
  [ -z "$LISTINGS" ] || LISTINGS+=","
  LISTINGS+="{\"desired_status\":\"$status\",\"pages\":[$PAGES]}"
done
# A task whose desired status changed between the two listings appears in both: it is described (and judged) once.
TASKS=()
while IFS= read -r arn; do [ -z "$arn" ] || TASKS+=("$arn"); done < <(printf '%s\n' "${ALL_ARNS[@]+"${ALL_ARNS[@]}"}" | awk '!seen[$0]++')
{
  printf '{"format":"18COSMOS/L6-6P-CLUSTER-TASKS/v1","cluster":"gs-%s","listed_at":"%s","listings":[%s],"task_count":%d,"batches":[' "$ENVIRONMENT" "$LISTED_AT" "$LISTINGS" "${#TASKS[@]}"
  SEP=""
  for ((i = 0; i < ${#TASKS[@]}; i += DESCRIBE_BATCH)); do
    printf '%s' "$SEP"
    command aws --region "$REGION" --output json ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks "${TASKS[@]:i:DESCRIBE_BATCH}"
    SEP=","
  done
  printf ']}\n'
} > "$OUT/cluster-tasks.json.partial"
mv "$OUT/cluster-tasks.json.partial" "$OUT/cluster-tasks.json"
# (converged with L6-2: one target group per pool, gs-<env>-<pool>; the prerequisite judges the PRIMARY pool's group)
TG_ARN="$(command aws --region "$REGION" elbv2 describe-target-groups --names "gs-${ENVIRONMENT}-${PRIMARY}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" > "$OUT/target-health.json"
aws cloudfront get-distribution --id "$DISTRIBUTION" > "$OUT/distribution.json"
printf '{"format":"18COSMOS/L5-8-CAPTURE/v1","captured_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/capture.json"
echo "evidence written to $OUT (read-only captures; no secret is in any of them)"
