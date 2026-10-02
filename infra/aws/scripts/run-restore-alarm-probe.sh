#!/usr/bin/env bash
# LIVE-6 L6-6 (restore drill): the restore alarms' ALARM-PIPELINE INJECTION (the same contract as run-restore-alarm-probe.ps1).
# server/src/aws/deploy/staging/restoreAlarmProbe.ts is the probe program and the derivation of every case;
# restoreAlarmDrill.ts the precheck and the record. This script only launches the standalone probe tasks and captures AWS
# (describe-alarms, describe-tasks, the task's log, describe-alarm-history) into <evidence dir>/restore-alarms/, with
# machine timestamps.
#
#   infra/aws/scripts/run-restore-alarm-probe.sh inject     <env> <region> <run id> <dir> <r1|a4g|a4i|r2> <pool> <pools> [overlap|no-overlap] [<precheck timeout s>]
#   infra/aws/scripts/run-restore-alarm-probe.sh hold-start <env> <region> <run id> <dir> r3 <non-primary pool> <pools> [<hold seconds>] [<precheck timeout s>]
#   infra/aws/scripts/run-restore-alarm-probe.sh observe    <env> <region> <run id> <dir> <case> [<timeout s>]
#   infra/aws/scripts/run-restore-alarm-probe.sh hold-stop  <env> <region> <run id> <dir>
#   then: node dist/server/src/tools/awsDeploy.js stage-probe restore-alarms record --run-id R --evidence <dir> --environment <env> --pools p1,p2
#
# AN ALARM-PIPELINE INJECTION, NOT A FAULT: one standalone `ecs run-task` of the pool's running task definition whose command
# is the drill's `node -e` program over the image's own runtimeMetrics encoder (never start.ts) and whose GS_STORAGE is a
# value start.ts refuses. It takes no pool, role, routing, generation or game, touches no APPGEN, identity restore state or
# journal, and never the escrow. The task is started only after `stage-probe restore-alarms precheck` cleared it (the alarm
# not in ALARM; for `overlap`, the staging flip-suppression test open with both suppressors ALARM). Credentials: an operator
# identity that may ecs:RunTask / StopTask / DescribeTasks / DescribeServices / DescribeTaskDefinition / iam:PassRole,
# logs:GetLogEvents, cloudwatch:DescribeAlarms / DescribeAlarmHistory -- a profile or SSO session, never static keys.
set -euo pipefail

usage() { sed -n '8,12p' "$0" | sed 's/^# //' >&2; exit 2; }
[ $# -ge 5 ] || usage
MODE="$1"; ENVIRONMENT="$2"; REGION="$3"; RUN="$4"; OUT="$5"; shift 5
[[ "$RUN" =~ ^[a-z0-9][a-z0-9-]{5,39}$ ]] || { echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; }
case "$ENVIRONMENT" in prod*) echo "the restore alarm probe never runs in a prod* environment" >&2; exit 2;; esac
CLUSTER="gs-${ENVIRONMENT}"
SERVER="$(cd "$(dirname "$0")/../../../server" && pwd)"
mkdir -p "$OUT/restore-alarms"
EVIDENCE="$(cd "$OUT" && pwd)"
DIR="$EVIDENCE/restore-alarms"
awsj() { aws --region "$REGION" --output json "$@"; }
probe() { (cd "$SERVER" && node dist/server/src/tools/awsDeploy.js stage-probe restore-alarms "$@"); }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
json_field() { node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^﻿/,""));let x=v;for(const k of process.argv[2].split("."))x=x==null?undefined:x[k];process.stdout.write(x==null?"":Array.isArray(x)?x.join(" "):String(x))' "$1" "$2"; }

case "$MODE" in
  inject|hold-start)
    [ $# -ge 3 ] || usage
    CASE="$1"; POOL="$2"; POOLS="$3"; shift 3
    if [ "$MODE" = inject ]; then
      case "$CASE" in r1|a4g|a4i|r2) ;; *) echo "inject takes r1, a4g, a4i or r2 (R3 is a hold: hold-start r3)" >&2; exit 2;; esac
      OVERLAP_ARGS=(); HOLD_ARGS=()
      if [ "${1:-no-overlap}" = overlap ]; then OVERLAP_ARGS=(--overlap); fi
      [ $# -ge 1 ] && shift
      TIMEOUT="${1:-600}"
    else
      [ "$CASE" = r3 ] || { echo "hold-start takes r3 only (the counters are injected once: inject)" >&2; exit 2; }
      OVERLAP_ARGS=(); HOLD_ARGS=(--hold-seconds "${1:-4500}")
      [ $# -ge 1 ] && shift
      TIMEOUT="${1:-600}"
      if [ -f "$DIR/r3-task.json" ]; then echo "an r3 hold was already started for this run (restore-alarms/r3-task.json); stop it with hold-stop" >&2; exit 1; fi
    fi
    [[ "$POOL" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || { echo "<pool> names a pool of the deployment" >&2; exit 2; }
    # The precheck over a capture taken right now; polled while NOT YET (exit 10): nothing is started before it clears.
    DEADLINE=$(( $(now_ms) + 1000 * TIMEOUT ))
    while true; do
      FROM="$(now_ms)"
      awsj cloudwatch describe-alarms --alarm-name-prefix "gs-${ENVIRONMENT}-" --alarm-types MetricAlarm CompositeAlarm > "$DIR/raw-$CASE-pre-alarms.json"
      TO="$(now_ms)"
      printf '{"captured_from":%s,"captured_to":%s}\n' "$FROM" "$TO" > "$DIR/raw-$CASE-pre-stamp.json"
      set +e
      probe precheck --run-id "$RUN" --evidence "$EVIDENCE" --environment "$ENVIRONMENT" --pools "$POOLS" --case "$CASE" --pool "$POOL" "${OVERLAP_ARGS[@]}"
      CODE=$?
      set -e
      [ "$CODE" -eq 0 ] && break
      [ "$CODE" -eq 10 ] || { echo "the precheck refused: nothing was started" >&2; exit 1; }
      [ "$(now_ms)" -le "$DEADLINE" ] || { echo "the precheck did not clear within $TIMEOUT s: nothing was started" >&2; exit 1; }
      sleep 20
    done
    OVERRIDES="$(probe overrides --case "$CASE" --environment "$ENVIRONMENT" --pool "$POOL" --run-id "$RUN" "${HOLD_ARGS[@]}")"
    SVC="$(awsj ecs describe-services --cluster "$CLUSTER" --services "gs-${ENVIRONMENT}-${POOL}")"
    TD="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).services[0].taskDefinition))')"
    NETWORK="$(printf '%s' "$SVC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).services[0].networkConfiguration.awsvpcConfiguration;process.stdout.write(`awsvpcConfiguration={subnets=[${n.subnets.join(",")}],securityGroups=[${n.securityGroups.join(",")}],assignPublicIp=DISABLED}`)})')"
    DEF="$(awsj ecs describe-task-definition --task-definition "$TD")"
    LOG_GROUP="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-group"]))')"
    LOG_PREFIX="$(printf '%s' "$DEF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).taskDefinition.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]))')"
    OVERRIDES_FILE="$(mktemp)"
    trap 'rm -f "$OVERRIDES_FILE"' EXIT
    printf '%s' "$OVERRIDES" > "$OVERRIDES_FILE"
    TASK="$(aws --region "$REGION" ecs run-task --cluster "$CLUSTER" --task-definition "$TD" --launch-type FARGATE --count 1 --started-by "l6-6-restore-alarm-$CASE" --network-configuration "$NETWORK" --overrides "file://$OVERRIDES_FILE" --query 'tasks[0].taskArn' --output text)"
    TASK="$(printf '%s' "$TASK" | tr -d '\r\n')"
    echo "restore alarm probe ($CASE) task $TASK (on $TD): an alarm-pipeline injection"
    STREAM="$LOG_PREFIX/game-server/${TASK##*/}"
    printf '{"log_group":"%s","log_stream":"%s"}\n' "$LOG_GROUP" "$STREAM" > "$DIR/$CASE-log-stream.json"
    if [ "$MODE" = inject ]; then
      aws --region "$REGION" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
      awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/$CASE-task.json"
      awsj logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "$STREAM" --start-from-head > "$DIR/$CASE-log.json"
      echo "INJECTED: restore-alarms/$CASE-task.json, $CASE-log.json (observe $CASE next)"
    else
      aws --region "$REGION" ecs wait tasks-running --cluster "$CLUSTER" --tasks "$TASK"
      awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/r3-task.json"
      echo "HOLDING: restore-alarms/r3-task.json (bounded by its own hold; R3 needs sixty one-minute periods: observe r3 with a timeout of 5400 s)"
    fi
    ;;
  hold-stop)
    TASK="$(json_field "$DIR/r3-task.json" tasks.0.taskArn)"
    [ -n "$TASK" ] || { echo "restore-alarms/r3-task.json names no task" >&2; exit 1; }
    aws --region "$REGION" ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason "l6-6 restore alarm drill: hold-stop" --query 'task.taskArn' --output text > /dev/null
    aws --region "$REGION" ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
    awsj ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" > "$DIR/r3-task-stopped.json"
    echo "HOLD STOPPED: restore-alarms/r3-task-stopped.json"
    ;;
  observe)
    [ $# -ge 1 ] || usage
    CASE="$1"; TIMEOUT="${2:-900}"
    case "$CASE" in r1|a4g|a4i|r2|r3) ;; *) echo "<case> is r1, a4g, a4i, r2 or r3" >&2; exit 2;; esac
    [ -f "$DIR/$CASE-launch.json" ] || { echo "no restore-alarms/$CASE-launch.json: inject (or hold-start) first" >&2; exit 1; }
    ALARM="$(json_field "$DIR/$CASE-launch.json" alarm)"
    OVERLAP="$(json_field "$DIR/$CASE-launch.json" overlap)"
    DEADLINE=$(( $(now_ms) + 1000 * TIMEOUT ))
    while true; do
      FROM="$(now_ms)"
      awsj cloudwatch describe-alarms --alarm-name-prefix "gs-${ENVIRONMENT}-" --alarm-types MetricAlarm CompositeAlarm > "$DIR/raw-$CASE-alarms.json"
      awsj cloudwatch describe-alarm-history --alarm-name "$ALARM" --history-item-type StateUpdate > "$DIR/raw-$CASE-history.json"
      if [ "$OVERLAP" = true ]; then
        SUP="{"; SEP=""
        for pool in $(json_field "$DIR/suppression-window.json" pools); do
          ANSWER="$(awsj cloudwatch describe-alarm-history --alarm-name "gs-${ENVIRONMENT}-${pool}-flip-window" --history-item-type StateUpdate)"
          SUP="$SUP$SEP\"$pool\":$ANSWER"; SEP=","
        done
        printf '%s}\n' "$SUP" > "$DIR/raw-$CASE-suppressor-history.json"
      fi
      if [ "$CASE" = r3 ]; then
        awsj logs get-log-events --log-group-name "$(json_field "$DIR/r3-log-stream.json" log_group)" --log-stream-name "$(json_field "$DIR/r3-log-stream.json" log_stream)" --start-from-head --limit 50 > "$DIR/r3-log.json"
      fi
      TO="$(now_ms)"
      printf '{"captured_from":%s,"captured_to":%s}\n' "$FROM" "$TO" > "$DIR/raw-$CASE-stamp.json"
      set +e
      probe observe --run-id "$RUN" --evidence "$EVIDENCE" --environment "$ENVIRONMENT" --case "$CASE"
      CODE=$?
      set -e
      [ "$CODE" -eq 0 ] && exit 0
      [ "$CODE" -eq 10 ] || { echo "the $CASE case was refused" >&2; exit 1; }
      [ "$(now_ms)" -le "$DEADLINE" ] || { echo "the $CASE case was not observed within $TIMEOUT s" >&2; exit 1; }
      sleep 30
    done
    ;;
  *) usage ;;
esac
