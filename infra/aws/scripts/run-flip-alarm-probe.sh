#!/usr/bin/env bash
# LIVE-6 L6-6: the flip drill's ALARM observations (the same contract as run-flip-alarm-probe.ps1).
# server/src/aws/deploy/staging/flipAlarmDrill.ts is the program and the judge of every phase; this script only launches
# the standalone probe tasks and captures AWS (describe-tasks, describe-alarms, describe-alarm-history) into
# <evidence dir>/flip-alarms/, with machine timestamps.
#
#   infra/aws/scripts/run-flip-alarm-probe.sh inject     <environment> <region> <run id> <evidence dir> <pool>
#   infra/aws/scripts/run-flip-alarm-probe.sh hold-start <environment> <region> <run id> <evidence dir> <pool> [<hold seconds>]
#   infra/aws/scripts/run-flip-alarm-probe.sh observe    <environment> <region> <run id> <evidence dir> <phase> <pools> [<timeout s>]
#   infra/aws/scripts/run-flip-alarm-probe.sh hold-stop  <environment> <region> <run id> <evidence dir>
#   then: node dist/server/src/tools/awsDeploy.js stage-probe flip-alarms record --run-id R --evidence <dir> --environment <env> --pools p1,p2
#
# A CONTROLLED, OPT-IN MUTATION (inject, hold-start, hold-stop only): ONE standalone `ecs run-task` of the pool's running
# task definition whose command is the drill's `node -e` program (never start.ts) and whose GS_STORAGE is a value start.ts
# refuses; it takes no pool, role, routing, generation or game and never touches the escrow. inject and hold-start refuse
# unless <evidence dir>/flip-record.json's window is open now. Credentials: a profile or SSO session (never static keys)
# that may ecs:RunTask / StopTask / DescribeTasks / iam:PassRole, logs:GetLogEvents, cloudwatch:DescribeAlarms /
# DescribeAlarmHistory.
set -euo pipefail

usage() { sed -n '7,11p' "$0" | sed 's/^# //' >&2; exit 2; }
[ $# -ge 5 ] || usage
MODE="$1"; ENVIRONMENT="$2"; REGION="$3"; RUN="$4"; OUT="$5"; shift 5
[[ "$RUN" =~ ^[a-z0-9][a-z0-9-]{5,39}$ ]] || { echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; }
case "$ENVIRONMENT" in prod*) echo "the flip alarm probe never runs in a prod* environment" >&2; exit 2;; esac
CLUSTER="gs-${ENVIRONMENT}"
SERVER="$(cd "$(dirname "$0")/../../../server" && pwd)"
mkdir -p "$OUT/flip-alarms"
EVIDENCE="$(cd "$OUT" && pwd)"
DIR="$EVIDENCE/flip-alarms"
awsj() { aws --region "$REGION" --output json "$@"; }
probe() { (cd "$SERVER" && node dist/server/src/tools/awsDeploy.js stage-probe flip-alarms "$@"); }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

case "$MODE" in
  inject|hold-start)
    [ $# -ge 1 ] || usage
    POOL="$1"; HOLD="${2:-4500}"
    [[ "$POOL" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || { echo "<pool> names the flip pool" >&2; exit 2; }
    probe window --run-id "$RUN" --evidence "$EVIDENCE" || { echo "the flip record's window is not open: nothing was started" >&2; exit 1; }
    if [ "$MODE" = inject ]; then PMODE=inject; STARTED_BY=l6-6-flip-alarm-a1; HOLD_ARGS=(); else PMODE=hold; STARTED_BY=l6-6-flip-alarm-hold; HOLD_ARGS=(--hold-seconds "$HOLD"); fi
    if [ "$MODE" = hold-start ] && [ -f "$DIR/hold-task.json" ]; then echo "a hold was already started for this run (hold-task.json); stop it with hold-stop" >&2; exit 1; fi
    OVERRIDES="$(probe overrides --mode "$PMODE" --environment "$ENVIRONMENT" --pool "$POOL" --run-id "$RUN" "${HOLD_ARGS[@]}")"
    SVC="$(awsj ecs describe-services --cluster "$CLUSTER" --services "gs-${ENVIRONMENT}-${POOL}")"
    TD="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).services[0].taskDefinition))')"
    NETWORK="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).services[0].networkConfiguration.awsvpcConfiguration;process.stdout.write(`awsvpcConfiguration={subnets=[${n.subnets.join(",")}],securityGroups=[${n.securityGroups.join(",")}],assignPublicIp=DISABLED}`)})')"
    DEF="$(awsj ecs describe-task-definition --task-definition "$TD")"
    LOG_GROUP="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-group"]))')"
    LOG_PREFIX="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]))')"
    OVERRIDES_FILE="$(mktemp)"
    trap 'rm -f "$OVERRIDES_FILE"' EXIT
    printf '%s' "$OVERRIDES" > "$OVERRIDES_FILE"
    TASK="$(aws --region "$REGION" ecs run-task --cluster "$CLUSTER" --task-definition "$TD" --launch-type FARGATE --count 1 --started-by "$STARTED_BY" --network-configuration "$NETWORK" --overrides "file://$OVERRIDES_FILE" --query 'tasks[0].taskArn' --output text)"
    echo "flip alarm probe ($PMODE) task $TASK (on $TD)"
    if [ "$MODE" = inject ]; then
      aws --region "$REGION" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
      awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/inject-task.json"
      STREAM="$LOG_PREFIX/game-server/${TASK##*/}"
      printf '{"log_group":"%s","log_stream":"%s"}\n' "$LOG_GROUP" "$STREAM" > "$DIR/inject-log-stream.json"
      awsj logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$STREAM" --start-from-head > "$DIR/inject-log.json"
      echo "INJECTED: flip-alarms/inject-task.json, inject-log.json (observe the a1 phase next)"
    else
      aws --region "$REGION" ecs wait tasks-running --cluster "$CLUSTER" --tasks "$TASK"
      awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/hold-task.json"
      echo "HOLDING: flip-alarms/hold-task.json (bounded: $HOLD s; observe the during phase next)"
    fi
    ;;
  hold-stop)
    TASK="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^﻿/,"")).tasks[0].taskArn)' "$DIR/hold-task.json")"
    aws --region "$REGION" ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason "l6-6 flip alarm drill: hold-stop" --query 'task.taskArn' --output text > /dev/null
    aws --region "$REGION" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
    awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/hold-task-stopped.json"
    echo "HOLD STOPPED: flip-alarms/hold-task-stopped.json"
    ;;
  observe)
    [ $# -ge 2 ] || usage
    PHASE="$1"; POOLS="$2"; TIMEOUT="${3:-900}"
    case "$PHASE" in a1|during|after) ;; *) echo "<phase> is a1, during or after" >&2; exit 2;; esac
    DEADLINE=$(( $(now_ms) + 1000 * TIMEOUT ))
    while true; do
      FROM="$(now_ms)"
      awsj cloudwatch describe-alarms --alarm-name-prefix "gs-${ENVIRONMENT}-" --alarm-types MetricAlarm CompositeAlarm > "$DIR/raw-$PHASE-alarms.json"
      if [ "$PHASE" = a1 ]; then awsj cloudwatch describe-alarm-history --alarm-name "gs-${ENVIRONMENT}-a1-unexpected-task-loss" --history-item-type StateUpdate --max-records 100 > "$DIR/raw-a1-history.json"; fi
      TO="$(now_ms)"
      printf '{"captured_from":%s,"captured_to":%s}\n' "$FROM" "$TO" > "$DIR/raw-$PHASE-stamp.json"
      set +e
      probe observe --run-id "$RUN" --evidence "$EVIDENCE" --environment "$ENVIRONMENT" --pools "$POOLS" --phase "$PHASE"
      CODE=$?
      set -e
      [ "$CODE" -eq 0 ] && exit 0
      [ "$CODE" -eq 10 ] || { echo "the $PHASE phase was refused" >&2; exit 1; }
      [ "$(now_ms)" -le "$DEADLINE" ] || { echo "the $PHASE phase was not observed within $TIMEOUT s" >&2; exit 1; }
      sleep 20
    done
    ;;
  *) usage ;;
esac
