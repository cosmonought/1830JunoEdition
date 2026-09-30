#!/usr/bin/env bash
# LIVE-6 L6-6: capture ONE stack's real `terraform plan` for the staging certification -- NEVER an apply.
#
#   infra/aws/scripts/plan-evidence.sh <ledger|app> <evidence dir> <run id> [<terraform plan option> ...]
#   e.g.  infra/aws/scripts/plan-evidence.sh app ./evidence l6cert-0930a -var-file=staging.tfvars
#
# Run it with the stack already initialised (`terraform -chdir=infra/aws/stacks/<stack> init -backend-config=...`) and the
# credentials that stack's plan needs. It writes, under <evidence dir>/terraform/<stack>/:
#   version.json        terraform version -json (the Terraform and provider versions actually used)
#   plan-exitcode.txt   terraform plan -detailed-exitcode: 0 no changes, 2 changes, 1 an error
#   plan.json           terraform show -json of that saved plan ("{}" when the plan failed)
#   lock.hcl            the stack's .terraform.lock.hcl as used
#   run.json            the run this plan belongs to (the certification refuses another run's plan, or one older than
#                       the run's prerequisite by Terraform's own timestamp)
# The saved binary plan is deleted after `show`: nothing here can apply it. `awsDeploy stage-cert certify` judges the
# files (a destructive or replacing action outside a task-definition revision FAILS the certification).
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: $0 <ledger|app> <evidence dir> <run id> [<terraform plan option> ...]" >&2
  exit 2
fi
STACK="$1"; OUT="$2"; RUN="$3"; shift 3
if ! printf '%s' "$RUN" | grep -Eq '^[a-z0-9][a-z0-9-]{5,39}$'; then echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; fi
case "$STACK" in ledger|app) ;; *) echo "the stack is ledger or app" >&2; exit 2 ;; esac
for option in "$@"; do
  case "$option" in -auto-approve|-destroy|apply|destroy) echo "refused: $option (this script only plans)" >&2; exit 2 ;; esac
done
DIR="$(cd "$(dirname "$0")/../stacks/$STACK" && pwd)"
mkdir -p "$OUT/terraform/$STACK"
OUT="$(cd "$OUT/terraform/$STACK" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

terraform -chdir="$DIR" version -json > "$OUT/version.json"
set +e
terraform -chdir="$DIR" plan -input=false -detailed-exitcode -out="$WORK/stack.tfplan" "$@"
CODE=$?
set -e
printf '%s\n' "$CODE" > "$OUT/plan-exitcode.txt"
if [ -f "$WORK/stack.tfplan" ] && [ "$CODE" -ne 1 ]; then
  terraform -chdir="$DIR" show -json "$WORK/stack.tfplan" > "$OUT/plan.json"
else
  echo '{}' > "$OUT/plan.json"
fi
cp "$DIR/.terraform.lock.hcl" "$OUT/lock.hcl"
printf '{"format":"18COSMOS/L6-6-PLAN/v1","run_id":"%s","stack":"%s","captured_at":"%s"}\n' "$RUN" "$STACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/run.json"
echo "plan evidence for $STACK written to $OUT (exit $CODE; nothing applied)"
