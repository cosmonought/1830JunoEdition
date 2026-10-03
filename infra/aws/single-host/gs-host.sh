#!/usr/bin/env bash
# infra/aws/single-host/gs-host.sh -- COST-1: the OPERATOR's side of the single host (Linux / macOS / WSL; gs-host.ps1
# is the Windows twin). It runs one fixed host command through SSM Run Command (AWS-RunShellScript over the public SSM
# endpoints; free on EC2) and prints its output. There is no SSH. Arguments are validated HERE before anything is sent,
# and the remote command is built only from fixed templates -- nothing the caller types is interpreted by a shell remotely.
#
#   gs-host.sh status   <instance-id> [region]
#   gs-host.sh deploy   <instance-id> <sha256:digest> <build-id> [--measure] [region]
#   gs-host.sh rollback <instance-id> [region]
#   gs-host.sh stop     <instance-id> [--until-deploy] [region]
#   gs-host.sh measure-report <instance-id> [days] [region]
#   gs-host.sh arm64-smoke <instance-id> <sha256:digest> [region]      # step 12b: BEFORE deploy / edge cutover
#   gs-host.sh role-probe <instance-id> <sha256:digest> <run id> <kms|transactions> <generation> <pool> [region]   # F5 / F6
#
# arm64-smoke (OWNER-GATE FIX 1): the REQUIRED live ARM64 runtime smoke on the real Graviton host -- the two REVIEWED
# repository files (arm64-live-smoke.sh and the unchanged modules/single-host/tests/image-smoke.sh) sent as base64 (the
# remote line holds no quote). Save the output (tee) for `migration-guard edge-cutover --arm64-live-smoke <file>`.
#
# role-probe (PHASE 1 REMAINDER, F5 / F6): the reviewed host-role-probe.sh, sent the same way, runs the release image's
# own L6-6 task-role probe on the host under the instance role (kms = F5; transactions = F6, the disposable L6CERT#<run>
# partition). Save the output (tee) for `awsDeploy stage-probe host-role --capture <file>`.
#
# Needs AWS CLI v2 and operator credentials allowed ssm:SendCommand (document AWS-RunShellScript) on that instance and
# ssm:GetCommandInvocation. It prints identifiers and the host's own output only (the host has no secret to print).
set -euo pipefail
die() { printf 'gs-host: REFUSED: %s\n' "$*" >&2; exit 1; }
cmd="${1:-}"; instance="${2:-}"; shift 2 || true
[[ "$instance" =~ ^i-[0-9a-f]{8,17}$ ]] || die "an instance id (i-...) is required"
region="us-east-1"
case "$cmd" in
  status) remote="/opt/gs/bin/gs-health"; [ $# -ge 1 ] && region="$1" ;;
  deploy)
    digest="${1:-}"; build="${2:-}"; shift 2 || true
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "deploy needs the image digest sha256:<64 hex>"
    [[ "$build" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "deploy needs a build id ([A-Za-z0-9._-]{1,128})"
    measure=""; if [ "${1:-}" = "--measure" ]; then measure=" --measure"; shift; fi
    [ $# -ge 1 ] && region="$1"
    remote="/opt/gs/bin/gs-deploy $digest $build$measure" ;;
  rollback) remote="/opt/gs/bin/gs-rollback"; [ $# -ge 1 ] && region="$1" ;;
  stop)
    hold=""; if [ "${1:-}" = "--until-deploy" ]; then hold=" --until-deploy"; shift; fi
    [ $# -ge 1 ] && region="$1"
    remote="/opt/gs/bin/gs-stop$hold" ;;
  measure-report)
    days="${1:-14}"; [[ "$days" =~ ^[0-9]{1,3}$ ]] || die "days must be a whole number"; shift || true
    [ $# -ge 1 ] && region="$1"
    remote="/opt/gs/bin/gs-measure-report $days" ;;
  arm64-smoke)
    digest="${1:-}"; shift || true
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "arm64-smoke needs the image digest sha256:<64 hex> (the release pushed at step 12)"
    [ $# -ge 1 ] && region="$1"
    here="$(cd "$(dirname "$0")" && pwd)"
    b64() { tr -d '\r' <"$1" | base64 | tr -d '\n'; }
    wrapper="$(b64 "$here/arm64-live-smoke.sh")"; smoke="$(b64 "$here/../modules/single-host/tests/image-smoke.sh")"
    remote="d=\$(mktemp -d) && printf %s $wrapper | base64 -d > \$d/w && printf %s $smoke | base64 -d > \$d/s && bash \$d/w $digest \$d/s; rc=\$?; rm -rf \$d; exit \$rc" ;;
  role-probe)
    digest="${1:-}"; run="${2:-}"; probe="${3:-}"; generation="${4:-}"; pool="${5:-}"; shift 5 || die "role-probe needs <sha256:digest> <run id> <kms|transactions> <generation> <pool>"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "role-probe needs the SERVING release digest sha256:<64 hex>"
    [[ "$run" =~ ^[a-z0-9][a-z0-9-]{5,39}$ ]] || die "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$"
    case "$probe" in kms | transactions) ;; *) die "the probe is kms (F5) or transactions (F6)" ;; esac
    [[ "$generation" =~ ^[1-9][0-9]{0,3}$ ]] || die "the generation is a positive whole number"
    [[ "$pool" =~ ^[a-z][a-z0-9-]{0,15}$ ]] || die "the pool must match ^[a-z][a-z0-9-]{0,15}\$"
    [ $# -ge 1 ] && region="$1"
    here="$(cd "$(dirname "$0")" && pwd)"
    script="$(tr -d '\r' <"$here/host-role-probe.sh" | base64 | tr -d '\n')"
    remote="d=\$(mktemp -d) && printf %s $script | base64 -d > \$d/p && bash \$d/p $digest $run $probe $generation $pool; rc=\$?; rm -rf \$d; exit \$rc" ;;
  *) die "usage: gs-host.sh status|deploy|rollback|stop|measure-report|arm64-smoke|role-probe <instance-id> ..." ;;
esac
[[ "$region" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || die "region must be an AWS region"

params="$(mktemp)"; trap 'rm -f "$params"' EXIT
printf '{"commands":["%s"],"executionTimeout":["900"]}' "$remote" >"$params"
id="$(aws ssm send-command --region "$region" --instance-ids "$instance" --document-name AWS-RunShellScript \
  --comment "gs-host $cmd" --parameters "file://$params" --timeout-seconds 600 --query Command.CommandId --output text)"
printf 'gs-host: %s on %s (command %s)\n' "$cmd" "$instance" "$id"
while :; do
  sleep 5
  status="$(aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)"
  case "$status" in Pending | InProgress | Delayed) continue ;; esac
  break
done
aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query StandardOutputContent --output text
err="$(aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query StandardErrorContent --output text)"
[ -n "$err" ] && [ "$err" != "None" ] && printf '%s\n' "$err" >&2
[ "$status" = Success ] || die "the host command ended $status"
