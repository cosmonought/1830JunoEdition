#!/usr/bin/env bash
# LIVE-6 L6-6: run the staging certification's TASK-ROLE probe inside one ECS task (the task role, the task's network and
# VPC endpoints, the primary pool's RUNNING task definition), then collect its record into the evidence directory.
#
#   infra/aws/scripts/run-task-probe.sh <environment> <region> <primary pool> <generation> <run id> <evidence dir> [--disposable-writes]
#
# THIS IS A CONTROLLED, OPT-IN MUTATION: it starts ONE standalone task (`ecs run-task`) and nothing else. It never starts the
# game server beside the service (which would fence the serving task):
#   - the container's command is OVERRIDDEN to `awsDeploy stage-probe task-role` (the probe, which takes no pool, role or
#     game), and GS_STORAGE is overridden to a value start.ts refuses (exit 2), so even a lost command override starts
#     nothing;
#   - it refuses unless <evidence dir>/prerequisite.json is PASS for this run (`awsDeploy stage-cert prerequisite`).
# What the probe itself does (see server/src/aws/deploy/staging/): the IAM probe's writes carry a condition that can never
# hold (nothing is written); KMS Signs over disposable digests (no transaction, no relayer sequence, no ledger); and ONLY
# with --disposable-writes, writes and deletes the one partition L6CERT#<run id> of the game table.
#
# Credentials: an operator identity that may ecs:RunTask / ecs:DescribeTasks / iam:PassRole (the task and execution roles)
# and logs:GetLogEvents -- NOT the bootstrap/verify role, which can start nothing. Written: probe-task-role-run.json (the
# task's describe-tasks), probe-task-role-log.json (its log events), then probe-task-role.json (`stage-probe collect`).
set -euo pipefail
if [ "$#" -ne 6 ] && [ "$#" -ne 7 ]; then
  echo "usage: $0 <environment> <region> <primary pool> <generation> <run id> <evidence dir> [--disposable-writes]" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; POOL="$3"; GENERATION="$4"; RUN="$5"; OUT="$6"; WRITES="${7:-}"
if [ -n "$WRITES" ] && [ "$WRITES" != "--disposable-writes" ]; then echo "the only option is --disposable-writes" >&2; exit 2; fi
if ! printf '%s' "$RUN" | grep -Eq '^[a-z0-9][a-z0-9-]{5,39}$'; then echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; fi
if ! grep -q '"verdict": "PASS"' "$OUT/prerequisite.json" 2>/dev/null || ! grep -q "\"run_id\": \"$RUN\"" "$OUT/prerequisite.json"; then
  echo "$OUT/prerequisite.json is not PASS for $RUN: run \`awsDeploy stage-cert prerequisite\` first; nothing was started" >&2
  exit 1
fi
CLUSTER="gs-${ENVIRONMENT}"; SERVICE="gs-${ENVIRONMENT}-${POOL}"
SERVER="$(cd "$(dirname "$0")/../../../server" && pwd)"
aws() { command aws --region "$REGION" "$@"; }

TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
SUBNETS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets' --output text | tr '\t' ',')"
SGROUPS="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups' --output text | tr '\t' ',')"
RUNTIME="$(aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[0].environment[?name=='GS_AWS_CONFIG_PARAMETER'].value | [0]" --output text)"
LOG_GROUP="$(aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[0].logConfiguration.options.\"awslogs-group\"" --output text)"
LOG_PREFIX="$(aws ecs describe-task-definition --task-definition "$TD" --query "taskDefinition.containerDefinitions[0].logConfiguration.options.\"awslogs-stream-prefix\"" --output text)"

EXTRA=""
if [ -n "$WRITES" ]; then EXTRA=",\"--disposable-writes\",\"L6CERT#${RUN}\""; fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
OVERRIDES="$(mktemp)"
trap 'rm -f "$OVERRIDES"' EXIT
printf '{"containerOverrides":[{"name":"game-server","command":["node","dist/server/src/tools/awsDeploy.js","stage-probe","task-role","--run-id","%s","--runtime-parameter","%s","--environment","%s","--generation","%s","--pool","%s"%s],"environment":[{"name":"GS_STORAGE","value":"l6-6-probe-not-a-server"}]}]}' \
  "$RUN" "$RUNTIME" "$ENVIRONMENT" "$GENERATION" "$POOL" "$EXTRA" > "$OVERRIDES"

TASK="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TD" --launch-type FARGATE --count 1 --started-by l6-6-cert \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SGROUPS}],assignPublicIp=DISABLED}" \
  --overrides "file://${OVERRIDES}" --query 'tasks[0].taskArn' --output text)"
echo "certifier task $TASK (on $TD); waiting for it to stop"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --output json > "$OUT/probe-task-role-run.json"
aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "${LOG_PREFIX}/game-server/${TASK##*/}" --start-from-head --output json > "$OUT/probe-task-role-log.json"
(cd "$SERVER" && node dist/server/src/tools/awsDeploy.js stage-probe collect --run-id "$RUN" --evidence "$OUT")
