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
#   infra/aws/scripts/drain-pool.sh <environment> <region> <pool>
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "usage: $0 <environment> <region> <pool>" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; POOL="$3"
CLUSTER="gs-${ENVIRONMENT}"; SERVICE="gs-${ENVIRONMENT}-${POOL}"
aws() { command aws --region "$REGION" "$@"; }

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
if [ "$COUNTS" != "$(printf '0\t0')" ]; then
  echo "the pool is not drained (running, pending: $COUNTS); do not deploy" >&2
  exit 1
fi
echo "$SERVICE drained (every task STOPPED after its graceful shutdown). Now: terraform apply (desired_count 1 starts the new task)."
