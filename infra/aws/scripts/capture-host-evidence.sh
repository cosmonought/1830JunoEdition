#!/usr/bin/env bash
# COST-2A: capture the SINGLE HOST's control-plane EVIDENCE that
#   npm run awsDeploy -- verify --topology (coexist | single-host) --evidence <dir> ...
# judges (server/src/aws/deploy/hostVerify.ts). The ECS-topology twin is capture-evidence.sh (unchanged).
#
# READ-ONLY: every AWS call below is a describe / get / list. Two OPT-IN exceptions, each named:
#   --host-status         ONE `ssm send-command` of the FIXED read-only host script /opt/gs/bin/gs-health (the same
#                         command `gs-host.sh status` sends; nothing the caller types reaches the host). It needs
#                         ssm:SendCommand (the operator's credentials); without it the host checks are NOT EVALUATED.
#   --terraform-dir <d>   `terraform output -json` in that (initialised) stack directory -- refused if any output is
#                         marked sensitive.
# Never read: an SSM parameter's value, a secret, the instance's user data, a budget's subscribers.
#
# A FAILED READ NEVER LOOKS LIKE AN EMPTY ONE: each answer is written whole to <name>.json, or its failure to
# <name>.error.json (the CLI's message, no credential), and the run continues; the verifier reports every check that
# needed it as NOT EVALUATED (never PASS). The manifest (written last) lists every call and whether it succeeded.
#
#   infra/aws/scripts/capture-host-evidence.sh <environment> <region> <instance-id | none> <distribution id> <out dir>
#       [--host-status] [--terraform-dir <stack dir>]
#   infra/aws/scripts/capture-host-evidence.sh --host-status-only <environment> <region> <instance-id> <out dir>
#       (adds host-health.json to an existing capture, e.g. with the operator's credentials; the manifest is left as is)
#
# Exit: 0 every read succeeded; 1 at least one read failed (the evidence is still written, and says which); 2 usage.
set -uo pipefail

usage() { echo "usage: $0 <environment> <region> <instance-id|none> <distribution id> <out dir> [--host-status] [--terraform-dir <dir>]" >&2; echo "       $0 --host-status-only <environment> <region> <instance-id> <out dir>" >&2; exit 2; }

HOST_STATUS=false; HOST_STATUS_ONLY=false; TF_DIR=""
if [ "${1:-}" = "--host-status-only" ]; then
  [ "$#" -eq 5 ] || usage
  HOST_STATUS_ONLY=true; HOST_STATUS=true; ENVIRONMENT="$2"; REGION="$3"; INSTANCE="$4"; OUT="$5"; DISTRIBUTION=""
else
  [ "$#" -ge 5 ] || usage
  ENVIRONMENT="$1"; REGION="$2"; INSTANCE="$3"; DISTRIBUTION="$4"; OUT="$5"; shift 5
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --host-status) HOST_STATUS=true; shift ;;
      --terraform-dir) [ "$#" -ge 2 ] || usage; TF_DIR="$2"; shift 2 ;;
      *) usage ;;
    esac
  done
fi
[[ "$ENVIRONMENT" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "environment: ^[a-z][a-z0-9-]{0,31}$" >&2; exit 2; }
[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "region: an AWS region" >&2; exit 2; }
[[ "$INSTANCE" =~ ^i-[0-9a-f]{8,17}$ || "$INSTANCE" = none ]] || { echo "instance: i-... or none" >&2; exit 2; }
[ "$HOST_STATUS_ONLY" = true ] || [[ "$DISTRIBUTION" =~ ^[A-Z0-9]{8,20}$ ]] || { echo "distribution: a CloudFront distribution id" >&2; exit 2; }
if [ "$HOST_STATUS" = true ] && [ "$INSTANCE" = none ]; then echo "--host-status needs a host (instance id)" >&2; exit 2; fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"   # absolute: later steps run from other directories (terraform's)

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FAILED=0
CALLS_FILE="$OUT/.calls"
[ "$HOST_STATUS_ONLY" = true ] || : >"$CALLS_FILE"

# JSON string content: control characters dropped, backslash and quote escaped (the CLI's messages; never a credential).
json_escape() { printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
record() { printf '%s %s\n' "$1" "$2" >>"$CALLS_FILE"; }
error_file() { # <file> <message> <exit>
  local base="${1%.json}"
  printf '{"error":"%s","exit":%d}\n' "$(json_escape "${2:0:500}")" "$3" >"$OUT/$base.error.json"
  record "$1" false; FAILED=$((FAILED + 1))
}
# capture <file> <aws args...>: the answer whole, or its failure -- never half a file, never a stale one.
capture() {
  local file="$1"; shift
  local err rc
  rm -f "$OUT/$file" "$OUT/${file%.json}.error.json" "$OUT/$file.partial"
  if err="$(command aws --region "$REGION" --output json "$@" 2>&1 >"$OUT/$file.partial")"; then
    mv "$OUT/$file.partial" "$OUT/$file"; record "$file" true
  else
    rc=$?
    rm -f "$OUT/$file.partial"
    error_file "$file" "$err" "$rc"
  fi
}
# One value by --query (text), or empty on failure (the dependent capture then records why).
value() { command aws --region "$REGION" --output text "$@" 2>/dev/null || true; }

host_status() {
  local params id status tries=0
  rm -f "$OUT/host-health.json" "$OUT/host-health.error.json"
  params="$(mktemp)"
  printf '{"commands":["/opt/gs/bin/gs-health"],"executionTimeout":["120"]}' >"$params"
  if ! id="$(command aws --region "$REGION" ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
      --comment "capture-host-evidence gs-health" --parameters "file://$params" --timeout-seconds 120 --query Command.CommandId --output text 2>&1)"; then
    rm -f "$params"; error_file host-health.json "the Run Command was refused: $id" 1; return
  fi
  rm -f "$params"
  while :; do
    sleep 3; tries=$((tries + 1))
    status="$(value ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query Status)"
    case "$status" in Pending | InProgress | Delayed | "") [ "$tries" -lt 60 ] && continue ;; esac
    break
  done
  # gs-health exits non-zero while the server is not ready: the invocation is still the evidence (the verifier reads it).
  capture host-health.json ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE"
}

if [ "$HOST_STATUS_ONLY" = true ]; then
  [ -f "$OUT/manifest.json" ] || { echo "$OUT has no manifest.json: run the full capture first" >&2; exit 2; }
  grep -q "\"instance_id\":\"$INSTANCE\"" "$OUT/manifest.json" || { echo "$OUT was captured for another host" >&2; exit 2; }
  # The manifest is left as the full capture wrote it (its time is the freshness bound); the verifier takes the directory
  # as it is now -- host-health.json present and no host-health.error.json -- and judges the invocation's own time.
  host_status
  rm -f "$CALLS_FILE"
  if [ -f "$OUT/host-health.json" ]; then echo "host status added to $OUT"; exit 0; fi
  echo "host status FAILED (see $OUT/host-health.error.json)" >&2; exit 1
fi

# Every earlier ANSWER goes first -- by its evidence name only (never anything else in the directory: a report or record
# kept beside it, or a directory named by mistake, is left alone). A file this run does not write is never judged as this
# run's: the verifier also refuses any file the manifest does not list. The operator's snapshot is taken AFTER this capture.
EVIDENCE_NAMES=(manifest.json caller-identity.json instances.json instances-by-profile.json credit-specification.json termination-protection.json volumes.json image.json network-interfaces.json addresses.json security-groups.json prefix-list.json nat-gateways.json vpc-endpoints.json ssm-instance.json instance-profile.json role.json role-attached-policies.json role-inline-policies.json role-policy.json distribution-config.json origin-request-policy.json log-groups.json container-insights-log-groups.json alarms.json budgets.json ecs-clusters.json ecs-services.json ecs-running-tasks.json load-balancers.json target-groups.json host-health.json terraform-outputs.json runtime-snapshot.json)
for name in "${EVIDENCE_NAMES[@]}"; do rm -f "$OUT/$name" "$OUT/${name%.json}.error.json" "$OUT/$name.partial"; done
rm -f "$OUT"/target-health-*.json "$OUT"/target-health-*.error.json "$OUT"/target-health-listing.error.json

NAMES_PREFIX="gs-${ENVIRONMENT}-"
capture caller-identity.json sts get-caller-identity
ACCOUNT="$(value sts get-caller-identity --query Account)"
CALLER="$(value sts get-caller-identity --query Arn)"

# --- EC2: every single-host instance of this environment (a second host must be SEEN to be refused) -----------------
capture instances.json ec2 describe-instances --filters "Name=tag:gs:environment,Values=$ENVIRONMENT" "Name=tag:gs:component,Values=single-host" "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped"
# ... and every instance holding the HOST ROLE's profile, tagged or not (tags can be removed; the role's authority cannot).
if [[ "$ACCOUNT" =~ ^[0-9]{12}$ ]]; then
  capture instances-by-profile.json ec2 describe-instances --filters "Name=iam-instance-profile.arn,Values=arn:aws:iam::${ACCOUNT}:instance-profile/${NAMES_PREFIX}host-app" "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped"
else error_file instances-by-profile.json "the account could not be read (the host profile's ARN names it)" 1; fi
if [ "$INSTANCE" != none ]; then
  read -r AMI _VPC <<<"$(value ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].[ImageId,VpcId]')"
  capture credit-specification.json ec2 describe-instance-credit-specifications --instance-ids "$INSTANCE"
  capture termination-protection.json ec2 describe-instance-attribute --instance-id "$INSTANCE" --attribute disableApiTermination
  capture volumes.json ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$INSTANCE"
  if [[ "${AMI:-}" =~ ^ami-[0-9a-f]+$ ]]; then capture image.json ec2 describe-images --image-ids "$AMI"; else error_file image.json "the instance's AMI could not be read" 1; fi
  capture network-interfaces.json ec2 describe-network-interfaces --filters "Name=attachment.instance-id,Values=$INSTANCE"
  capture ssm-instance.json ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE"
  # IAM: the host's instance profile, role and its policies (policy documents hold no secret).
  capture instance-profile.json iam get-instance-profile --instance-profile-name "${NAMES_PREFIX}host-app"
  capture role.json iam get-role --role-name "${NAMES_PREFIX}host-app"
  capture role-attached-policies.json iam list-attached-role-policies --role-name "${NAMES_PREFIX}host-app"
  capture role-inline-policies.json iam list-role-policies --role-name "${NAMES_PREFIX}host-app"
  capture role-policy.json iam get-role-policy --role-name "${NAMES_PREFIX}host-app" --policy-name gs-single-host-runtime
fi
# Every NAT gateway of the region (the verifier judges the host's VPC and the ECS era's, --legacy-vpc).
capture nat-gateways.json ec2 describe-nat-gateways
capture vpc-endpoints.json ec2 describe-vpc-endpoints
capture addresses.json ec2 describe-addresses
capture security-groups.json ec2 describe-security-groups --filters "Name=group-name,Values=${NAMES_PREFIX}host,${NAMES_PREFIX}task,${NAMES_PREFIX}alb,${NAMES_PREFIX}endpoints"
capture prefix-list.json ec2 describe-managed-prefix-lists --filters "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing"

# --- CloudFront: the distribution and the /gs* behaviour's origin request policy --------------------------------------
capture distribution-config.json cloudfront get-distribution-config --id "$DISTRIBUTION"
ORP_ID="$(value cloudfront get-distribution-config --id "$DISTRIBUTION" --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/gs*'] | [0].OriginRequestPolicyId")"
if [ -n "$ORP_ID" ] && [ "$ORP_ID" != None ]; then capture origin-request-policy.json cloudfront get-origin-request-policy --id "$ORP_ID"; else error_file origin-request-policy.json "the /gs* behaviour names no origin request policy" 1; fi

# --- Observability ---------------------------------------------------------------------------------------------------
capture log-groups.json logs describe-log-groups --log-group-name-prefix "/gs/${ENVIRONMENT}/"
capture container-insights-log-groups.json logs describe-log-groups --log-group-name-prefix "/aws/ecs/containerinsights/gs-${ENVIRONMENT}/"
capture alarms.json cloudwatch describe-alarms --alarm-name-prefix "$NAMES_PREFIX" --alarm-types MetricAlarm CompositeAlarm
if [[ "$ACCOUNT" =~ ^[0-9]{12}$ ]]; then capture budgets.json budgets describe-budgets --account-id "$ACCOUNT"; else error_file budgets.json "the account could not be read" 1; fi

# --- The ECS era: drained (coexist) or absent (single-host) -----------------------------------------------------------
capture ecs-clusters.json ecs describe-clusters --clusters "gs-${ENVIRONMENT}"
# Services and tasks whenever the cluster is not INACTIVE (PROVISIONING / DEPROVISIONING / FAILED count as present), and
# when that question itself could not be answered (an unanswered question never skips the capture).
LIVE="$(value ecs describe-clusters --clusters "gs-${ENVIRONMENT}" --query "length(clusters[?status!='INACTIVE'])")"
if [ "$LIVE" != 0 ]; then
  if SERVICES="$(command aws --region "$REGION" --output text ecs list-services --cluster "gs-${ENVIRONMENT}" --query 'serviceArns' 2>&1)"; then
    LIST=()
    for arn in $SERVICES; do [ "$arn" = None ] || LIST+=("$arn"); done
    if [ "${#LIST[@]}" -eq 0 ]; then printf '{"services":[],"failures":[]}\n' >"$OUT/ecs-services.json"; record ecs-services.json true
    elif [ "${#LIST[@]}" -gt 10 ]; then error_file ecs-services.json "more than 10 services in gs-${ENVIRONMENT}: describe them by hand" 1
    else capture ecs-services.json ecs describe-services --cluster "gs-${ENVIRONMENT}" --services "${LIST[@]}"; fi
  else error_file ecs-services.json "ecs list-services: $SERVICES" 1; fi
  capture ecs-running-tasks.json ecs list-tasks --cluster "gs-${ENVIRONMENT}" --desired-status RUNNING
fi
capture load-balancers.json elbv2 describe-load-balancers
capture target-groups.json elbv2 describe-target-groups
if TGS="$(command aws --region "$REGION" --output text elbv2 describe-target-groups --query "TargetGroups[?starts_with(TargetGroupName, '${NAMES_PREFIX}')].[TargetGroupName,TargetGroupArn]" 2>&1)"; then
  while read -r TG_NAME TG_ARN; do
    [ -n "${TG_NAME:-}" ] && [ "$TG_NAME" != None ] || continue
    capture "target-health-${TG_NAME}.json" elbv2 describe-target-health --target-group-arn "$TG_ARN"
  done <<<"$TGS"
else error_file target-health-listing.json "elbv2 describe-target-groups: $TGS" 1; fi

# --- Opt-in: the host's own line, and Terraform's outputs ----------------------------------------------------------------
HOST_STATUS_STATE="not-requested"
if [ "$HOST_STATUS" = true ]; then host_status; HOST_STATUS_STATE="$([ -f "$OUT/host-health.json" ] && echo captured || echo failed)"; fi
if [ -n "$TF_DIR" ]; then
  rm -f "$OUT/terraform-outputs.json" "$OUT/terraform-outputs.error.json"
  if TF="$(cd "$TF_DIR" && terraform output -json 2>"$OUT/.tf-stderr")"; then   # stderr apart: never inside the JSON
    rm -f "$OUT/.tf-stderr"
    if printf '%s' "$TF" | grep -q '"sensitive": *true'; then error_file terraform-outputs.json "an output is marked sensitive: refused (the evidence never carries one)" 1
    else printf '%s\n' "$TF" >"$OUT/terraform-outputs.json"; record terraform-outputs.json true; fi
  else error_file terraform-outputs.json "terraform output: $(cat "$OUT/.tf-stderr" 2>/dev/null)" 1; rm -f "$OUT/.tf-stderr"; fi
fi

# --- The source this capture was taken from, and the manifest (LAST) ------------------------------------------------------
REPO="$(cd "$(dirname "$0")" && git rev-parse --show-toplevel 2>/dev/null || true)"
COMMIT="$( [ -n "$REPO" ] && git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
DIRTY="$( [ -n "$REPO" ] && [ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] && echo true || echo false)"
CALLS="$(awk '{ printf "%s{\"file\":\"%s\",\"ok\":%s}", (NR > 1 ? "," : ""), $1, $2 }' "$CALLS_FILE")"
rm -f "$CALLS_FILE"
printf '{"format":"18COSMOS/HOST-EVIDENCE/v1","captured_at":"%s","finished_at":"%s","environment":"%s","region":"%s","account":"%s","caller_arn":"%s","instance_id":"%s","distribution":"%s","host_status":"%s","source_commit":"%s","source_dirty":%s,"calls":[%s]}\n' \
  "$STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ENVIRONMENT" "$REGION" "$(json_escape "$ACCOUNT")" "$(json_escape "$CALLER")" "$INSTANCE" "$DISTRIBUTION" "$HOST_STATUS_STATE" "$(json_escape "$COMMIT")" "$DIRTY" "$CALLS" >"$OUT/manifest.json.partial"
mv "$OUT/manifest.json.partial" "$OUT/manifest.json"
if [ "$FAILED" -gt 0 ]; then echo "evidence written to $OUT: $FAILED read(s) FAILED (see *.error.json; the verifier reports what they cover as NOT EVALUATED)" >&2; exit 1; fi
echo "evidence written to $OUT (read-only captures; no secret is in any of them)"
