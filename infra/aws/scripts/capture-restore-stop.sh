#!/usr/bin/env bash
# LIVE-6 L6-6 x L6-4: capture the RESTORE DRILL's stop -- every pool's service at zero and nothing running in the cluster --
# for the staging certification's `restore-quiet` gate. READ-ONLY (describe/list only). Run it after every pool was stopped
# and BEFORE `npm run recovery -- appgen-adopt ... --restore-id <restore id> --apply --stopped`: the certification requires
# the capture to name the SAME restore id and to precede APPGEN's adopted_at (by at most 6 h).
#
# L6-6R: the cluster listing holds every task whose desired status is RUNNING **and** every task whose desired status is
# STOPPED (a task still draining -- lastStatus RUNNING/DEACTIVATING/STOPPING -- has desired STOPPED and is still running),
# described in batches of 100 with nothing truncated ({"batches":[...]}); the gate requires every one of them STOPPED.
#
#   infra/aws/scripts/capture-restore-stop.sh <environment> <region> <run id> <restore id> <evidence dir> <pool> [<pool> ...]
set -euo pipefail
if [ "$#" -lt 6 ]; then
  echo "usage: $0 <environment> <region> <run id> <restore id> <evidence dir> <pool> [<pool> ...]" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; RUN="$3"; RESTORE="$4"; OUT="$5"; shift 5
if ! printf '%s' "$RUN" | grep -Eq '^[a-z0-9][a-z0-9-]{5,39}$'; then echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; fi
if ! printf '%s' "$RESTORE" | grep -Eq '^[a-z0-9][a-z0-9-]{2,63}$'; then echo "the restore id must match ^[a-z0-9][a-z0-9-]{2,63}\$ (the one appgen-adopt will name)" >&2; exit 2; fi
DIR="$OUT/restore-stop"
mkdir -p "$DIR"
SERVICES=()
for pool in "$@"; do SERVICES+=("gs-${ENVIRONMENT}-${pool}"); done
command aws --region "$REGION" --output json ecs describe-services --cluster "gs-${ENVIRONMENT}" --services "${SERVICES[@]}" > "$DIR/services.json"
# Each listing into a variable FIRST: a failed `aws` call stops the script (set -e) instead of looking like an empty list.
TASKS=()
for status in RUNNING STOPPED; do
  LISTED="$(command aws --region "$REGION" ecs list-tasks --cluster "gs-${ENVIRONMENT}" --desired-status "$status" --query 'taskArns[]' --output text)"
  for arn in $LISTED; do [ "$arn" = "None" ] || TASKS+=("$arn"); done
done
# One describe-tasks answer per batch of 100, each written WHOLE (its tasks and its failures from the same call) as
# {"batches":[<answer>,...]}; set -e stops the script on any failed call (never a partial file that looks complete).
{
  printf '{"batches":['
  SEP=""
  for ((i = 0; i < ${#TASKS[@]}; i += 100)); do
    printf '%s' "$SEP"
    command aws --region "$REGION" --output json ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks "${TASKS[@]:i:100}"
    SEP=","
  done
  printf ']}\n'
} > "$DIR/cluster-tasks.json"
printf '{"format":"18COSMOS/L6-6-RESTORE-STOP/v2","run_id":"%s","restore_id":"%s","captured_at":"%s"}\n' "$RUN" "$RESTORE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/stamp.json"
echo "restore stop captured in $DIR (read-only; now, and only if every service is at zero and every task STOPPED, appgen-adopt --restore-id $RESTORE)"
