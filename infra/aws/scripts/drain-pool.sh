#!/usr/bin/env bash
# LIVE-5 L5-8: the GUARANTEED no-overlap rollout for one pool (infra/aws/README.md "Rollout").
#
# Stop-first (minimumHealthyPercent 0 / maximumPercent 100) is how every pool's service deploys, but ECS counts only
# RUNNING/PENDING tasks against maximumPercent: while the old task deregisters and runs its graceful shutdown (up to
# stopTimeout 120 s) ECS may already start the new one, which takes the pool and fences the old task mid-drain (exit 3:
# safe -- the fences hold -- but no graceful drain, and a false `aws.task-lost`). This script removes that window: it scales
# the pool's service to 0, waits until every one of its tasks has STOPPED (its graceful shutdown finished), and leaves the
# next `terraform apply` (desired_count 1, the new revision or document) to start the new task from nothing.
#
# It changes ONE thing -- the service's desired count -- and nothing is served while the pool is drained.
#
#   infra/aws/scripts/drain-pool.sh <environment> <region> <pool> [<evidence dir> <run id>]
#
# LIVE-6 L6-6: with an evidence directory (and the certification's run id), it also records (read-only describes) what
# the staging certification's drain gate judges -- the pool's RUNNING tasks before the scale-down, the same tasks once
# STOPPED, the drained service, and a stamp naming the run -- under <evidence dir>/drain-<pool>/. It changes nothing more
# than it did before.
set -euo pipefail
if [ "$#" -ne 3 ] && [ "$#" -ne 5 ]; then
  echo "usage: $0 <environment> <region> <pool> [<evidence dir> <run id>]" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; POOL="$3"; EVIDENCE="${4:-}"; RUN="${5:-}"
CLUSTER="gs-${ENVIRONMENT}"; SERVICE="gs-${ENVIRONMENT}-${POOL}"
aws() { command aws --region "$REGION" "$@"; }

BEFORE=()
if [ -n "$EVIDENCE" ]; then
  mkdir -p "$EVIDENCE/drain-${POOL}"
  # Captured into a variable first: a failed listing stops the script BEFORE the scale-down (set -e).
  LISTED="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING --query 'taskArns[]' --output text)"
  for arn in $LISTED; do
    [ "$arn" = "None" ] || BEFORE+=("$arn")
  done
  if [ "${#BEFORE[@]}" -eq 0 ]; then echo '{"tasks":[],"failures":[]}' > "$EVIDENCE/drain-${POOL}/tasks-before.json"
  else aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${BEFORE[@]}" --output json > "$EVIDENCE/drain-${POOL}/tasks-before.json"; fi
fi

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 --query 'service.desiredCount' --output text >/dev/null
# Listed AFTER the scale-down (a replacement started just before it is included): every task still desired RUNNING must
# go, then every task of the service desired STOPPED (recently stopped ones included) must have reached STOPPED.
for _ in $(seq 1 60); do
  LEFT="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING --query 'taskArns' --output text)"
  if [ -z "$LEFT" ] || [ "$LEFT" = "None" ]; then break; fi
  sleep 5
done
STOPPING="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status STOPPED --query 'taskArns[:100]' --output text)"
if [ -n "$STOPPING" ] && [ "$STOPPING" != "None" ]; then
  # shellcheck disable=SC2086
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks $STOPPING
fi
COUNTS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].[runningCount,pendingCount]' --output text)"
if [ -n "$EVIDENCE" ]; then
  if [ "${#BEFORE[@]}" -eq 0 ]; then echo '{"tasks":[],"failures":[]}' > "$EVIDENCE/drain-${POOL}/tasks-after.json"
  else aws ecs describe-tasks --cluster "$CLUSTER" --tasks "${BEFORE[@]}" --output json > "$EVIDENCE/drain-${POOL}/tasks-after.json"; fi
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json > "$EVIDENCE/drain-${POOL}/service-after.json"
fi
if [ "$COUNTS" != "$(printf '0\t0')" ]; then
  echo "the pool is not drained (running, pending: $COUNTS); do not deploy" >&2
  exit 1
fi
if [ -n "$EVIDENCE" ]; then
  printf '{"format":"18COSMOS/L6-6-DRAIN/v1","run_id":"%s","pool":"%s","drained_at":"%s"}\n' "$RUN" "$POOL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$EVIDENCE/drain-${POOL}/drain.json"
fi
echo "$SERVICE drained (every task STOPPED after its graceful shutdown). Now: terraform apply (desired_count 1 starts the new task)."
