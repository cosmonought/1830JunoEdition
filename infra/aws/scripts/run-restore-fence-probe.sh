#!/usr/bin/env bash
# LIVE-6 L6-6 (restore drill): the OLD GENERATION'S FENCING PROBE, after the APPGEN adoption (the same contract as
# run-restore-fence-probe.ps1). server/src/aws/runtime/restoreFenceProbe.ts is the in-task probe;
# server/src/aws/deploy/staging/restoreFencing.ts builds its overrides and records probe-restore-fencing.json. This script
# only launches ONE standalone probe task and captures ECS's record of it and its own log into <evidence dir>/restore-fence/.
#
#   infra/aws/scripts/run-restore-fence-probe.sh ledger-kms <env> <region> <run id> <dir> <pool> <previous generation> <generation> <restore id>
#   infra/aws/scripts/run-restore-fence-probe.sh old-task   <env> <region> <run id> <dir> <pool> <previous generation> <generation> <restore id>
#   then (after capture-evidence): node dist/server/src/tools/awsDeploy.js stage-probe restore-fencing record --run-id R \
#        --evidence <dir> --runtime-parameter <ARN> --environment <env> --primary-pool <primary> --generation <generation>
#
# A CONTROLLED, OPT-IN PROBE, NOT A SERVER: `ecs run-task` of the pool's RUNNING task definition (the new generation's), with
# the container's command overridden to the probe (never start.ts) and GS_STORAGE overridden to a value start.ts refuses.
# The probe refuses to run unless APPGEN shows exactly this adoption. ledger-kms sends the ledger's generation fence for
# the OLD generation inside a transaction that can never commit (nothing is written) and asks the KMS gate for a Sign that
# never reaches KMS; old-task runs the production startup configured for the OLD generation, which refuses before the
# pool (exit 2). No pool, role, routing, game, KMS key or chain is touched. Credentials: an operator identity that may
# ecs:RunTask / DescribeTasks / DescribeServices / DescribeTaskDefinition / iam:PassRole and logs:GetLogEvents -- a
# profile or SSO session, never static keys; AWS CLI v2.
set -euo pipefail

usage() { sed -n '7,10p' "$0" | sed 's/^# //' >&2; exit 2; }
[ $# -ge 9 ] || usage
MODE="$1"; ENVIRONMENT="$2"; REGION="$3"; RUN="$4"; OUT="$5"; POOL="$6"; PREVIOUS="$7"; GENERATION="$8"; RESTORE="$9"
case "$MODE" in ledger-kms|old-task) ;; *) usage ;; esac
[[ "$RUN" =~ ^[a-z0-9][a-z0-9-]{5,39}$ ]] || { echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; }
case "$ENVIRONMENT" in prod*) echo "the restore fencing probe never runs in a prod* environment" >&2; exit 2;; esac
[[ "$POOL" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || { echo "<pool> names a pool of the deployment" >&2; exit 2; }
CLUSTER="gs-${ENVIRONMENT}"
SERVER="$(cd "$(dirname "$0")/../../../server" && pwd)"
mkdir -p "$OUT/restore-fence"
EVIDENCE="$(cd "$OUT" && pwd)"
DIR="$EVIDENCE/restore-fence"
awsj() { aws --region "$REGION" --output json "$@"; }
probe() { (cd "$SERVER" && node dist/server/src/tools/awsDeploy.js stage-probe restore-fencing "$@"); }

# An earlier attempt of this mode is moved aside (never deleted).
if [ -f "$DIR/$MODE-task.json" ]; then
  ASIDE="$DIR/superseded/$MODE-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$ASIDE"
  for f in "$DIR/$MODE"-*.json; do mv "$f" "$ASIDE/"; done
  echo "the previous $MODE attempt moved to restore-fence/superseded/$(basename "$ASIDE")"
fi
OVERRIDES="$(probe overrides --mode "$MODE" --run-id "$RUN" --environment "$ENVIRONMENT" --pool "$POOL" --previous-generation "$PREVIOUS" --generation "$GENERATION" --restore-id "$RESTORE" --old-game-table "gs-${ENVIRONMENT}-game-g${PREVIOUS}")"
printf '%s\n' "$OVERRIDES" > "$DIR/$MODE-overrides.json"
SVC="$(awsj ecs describe-services --cluster "$CLUSTER" --services "gs-${ENVIRONMENT}-${POOL}")"
TD="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).services[0].taskDefinition))')"
NETWORK="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).services[0].networkConfiguration.awsvpcConfiguration;process.stdout.write(`awsvpcConfiguration={subnets=[${n.subnets.join(",")}],securityGroups=[${n.securityGroups.join(",")}],assignPublicIp=DISABLED}`)})')"
DEF="$(awsj ecs describe-task-definition --task-definition "$TD")"
LOG_GROUP="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-group"]))')"
LOG_PREFIX="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]))')"
TASK="$(aws --region "$REGION" ecs run-task --cluster "$CLUSTER" --task-definition "$TD" --launch-type FARGATE --count 1 --started-by "l6-6-restore-fence-$MODE" --network-configuration "$NETWORK" --overrides "file://$DIR/$MODE-overrides.json" --query 'tasks[0].taskArn' --output text)"
TASK="$(printf '%s' "$TASK" | tr -d '\r\n')"
echo "restore fencing probe ($MODE) task $TASK (on $TD)"
STREAM="$LOG_PREFIX/game-server/${TASK##*/}"
printf '{"log_group":"%s","log_stream":"%s"}\n' "$LOG_GROUP" "$STREAM" > "$DIR/$MODE-log-stream.json"
aws --region "$REGION" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/$MODE-task.json"
awsj logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$STREAM" --start-from-head > "$DIR/$MODE-log.json"
echo "PROBED: restore-fence/$MODE-task.json, $MODE-log.json (after both modes and capture-evidence: stage-probe restore-fencing record)"
