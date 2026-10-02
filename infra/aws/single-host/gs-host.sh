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
  *) die "usage: gs-host.sh status|deploy|rollback|stop|measure-report <instance-id> ..." ;;
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
