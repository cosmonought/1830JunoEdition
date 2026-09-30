#!/usr/bin/env bash
# LIVE-6 L6-6 x L6-4: capture the RESTORE DRILL's stop -- every pool's service at zero and nothing running in the cluster --
# for the staging certification's `restore-quiet` gate. READ-ONLY (describe/list only). Run it after every pool was stopped
# and BEFORE `npm run recovery -- appgen-adopt ... --apply --stopped`: the certification requires the capture to precede
# APPGEN's adopted_at.
#
#   infra/aws/scripts/capture-restore-stop.sh <environment> <region> <run id> <evidence dir> <pool> [<pool> ...]
set -euo pipefail
if [ "$#" -lt 5 ]; then
  echo "usage: $0 <environment> <region> <run id> <evidence dir> <pool> [<pool> ...]" >&2
  exit 2
fi
ENVIRONMENT="$1"; REGION="$2"; RUN="$3"; OUT="$4"; shift 4
if ! printf '%s' "$RUN" | grep -Eq '^[a-z0-9][a-z0-9-]{5,39}$'; then echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; fi
DIR="$OUT/restore-stop"
mkdir -p "$DIR"
SERVICES=()
for pool in "$@"; do SERVICES+=("gs-${ENVIRONMENT}-${pool}"); done
command aws --region "$REGION" --output json ecs describe-services --cluster "gs-${ENVIRONMENT}" --services "${SERVICES[@]}" > "$DIR/services.json"
LISTED="$(command aws --region "$REGION" ecs list-tasks --cluster "gs-${ENVIRONMENT}" --desired-status RUNNING --query 'taskArns[:100]' --output text)"
TASKS=()
for arn in $LISTED; do [ "$arn" = "None" ] || TASKS+=("$arn"); done
if [ "${#TASKS[@]}" -eq 0 ]; then echo '{"tasks":[],"failures":[]}' > "$DIR/cluster-tasks.json"
else command aws --region "$REGION" --output json ecs describe-tasks --cluster "gs-${ENVIRONMENT}" --tasks "${TASKS[@]}" > "$DIR/cluster-tasks.json"; fi
printf '{"format":"18COSMOS/L6-6-RESTORE-STOP/v1","run_id":"%s","captured_at":"%s"}\n' "$RUN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/stamp.json"
echo "restore stop captured in $DIR (read-only; now, and only if every service is at zero, appgen-adopt)"
