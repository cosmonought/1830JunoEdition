#!/usr/bin/env bash
# LIVE-6 L6-6: capture ONE stack's real `terraform plan` for the staging certification -- NEVER an apply.
# COST-2B: also the single-host stack, and `--keep-plan` for the migration guards (infra/aws/SINGLE_HOST_MIGRATION.md).
#
#   infra/aws/scripts/plan-evidence.sh <ledger|app|single-host> <evidence dir> <run id> [--keep-plan] [<terraform plan option> ...]
#   e.g.  infra/aws/scripts/plan-evidence.sh app ./evidence l6cert-0930a -var-file=staging.tfvars
#         infra/aws/scripts/plan-evidence.sh app ./migration cost2-cutover --keep-plan -var-file=staging.tfvars \
#           '-target=module.app.aws_cloudfront_distribution.site[0]'
#
# Run it with the stack already initialised (`terraform -chdir=infra/aws/stacks/<stack> init -backend-config=...`) and the
# credentials that stack's plan needs. It writes, under <evidence dir>/terraform/<stack>/:
#   version.json        terraform version -json (the Terraform and provider versions actually used)
#   plan-exitcode.txt   terraform plan -detailed-exitcode: 0 no changes, 2 changes, 1 an error
#   plan.json           terraform show -json of that saved plan ("{}" when the plan failed)
#   lock.hcl            the stack's .terraform.lock.hcl as used
#   run.json            the run this plan belongs to (the certification refuses another run's plan, or one older than
#                       the run's prerequisite by Terraform's own timestamp)
# Without --keep-plan the saved binary plan is deleted after `show`: nothing here can apply it. `awsDeploy stage-cert
# certify` judges the files (a destructive or replacing action outside a task-definition revision FAILS the certification).
# WITH --keep-plan (COST-2B, a migration step) the binary plan is kept as stack.tfplan beside plan.json, with its SHA-256
# in stack.tfplan.sha256: `awsDeploy migration-guard <gate> --plan-evidence <dir>/terraform/<stack>` judges plan.json, and
# only after its PASS and the owner's GO is EXACTLY that file applied (`terraform -chdir=... apply <dir>/.../stack.tfplan`;
# Terraform refuses it if the state moved since). This script itself never applies.
set -euo pipefail
if [ "$#" -lt 3 ]; then
  echo "usage: $0 <ledger|app|single-host> <evidence dir> <run id> [--keep-plan] [<terraform plan option> ...]" >&2
  exit 2
fi
STACK="$1"; OUT="$2"; RUN="$3"; shift 3
if ! printf '%s' "$RUN" | grep -Eq '^[a-z0-9][a-z0-9-]{5,39}$'; then echo "the run id must match ^[a-z0-9][a-z0-9-]{5,39}\$" >&2; exit 2; fi
case "$STACK" in ledger|app|single-host) ;; *) echo "the stack is ledger, app or single-host" >&2; exit 2 ;; esac
KEEP=0
if [ "${1:-}" = "--keep-plan" ]; then KEEP=1; shift; fi
for option in "$@"; do
  case "$option" in -auto-approve|-destroy|apply|destroy|--keep-plan) echo "refused: $option (this script only plans; --keep-plan comes first)" >&2; exit 2 ;; esac
done
DIR="$(cd "$(dirname "$0")/../stacks/$STACK" && pwd)"
mkdir -p "$OUT/terraform/$STACK"
OUT="$(cd "$OUT/terraform/$STACK" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# A previous capture's saved plan never survives into this one (the guard would otherwise bind a stale binary plan).
rm -f "$OUT/stack.tfplan" "$OUT/stack.tfplan.sha256"
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

terraform -chdir="$DIR" version -json > "$OUT/version.json"
set +e
terraform -chdir="$DIR" plan -input=false -detailed-exitcode -out="$WORK/stack.tfplan" "$@"
CODE=$?
set -e
printf '%s\n' "$CODE" > "$OUT/plan-exitcode.txt"
if [ -f "$WORK/stack.tfplan" ] && [ "$CODE" -ne 1 ]; then
  terraform -chdir="$DIR" show -json "$WORK/stack.tfplan" > "$OUT/plan.json"
  if [ "$KEEP" -eq 1 ]; then
    cp "$WORK/stack.tfplan" "$OUT/stack.tfplan"
    # Both hashes in one file: the binary plan to apply AND the plan.json shown from it, written by the same run.
    ( cd "$OUT" && sha256 stack.tfplan plan.json > stack.tfplan.sha256 )
  fi
else
  echo '{}' > "$OUT/plan.json"
fi
cp "$DIR/.terraform.lock.hcl" "$OUT/lock.hcl"
# COST-2B: the checkout this plan was made from. The module code a plan cannot show (cloud-init templates, scripts) is the
# committed code only if infra/aws is clean: no modified, untracked or override file (override.tf is git-ignored).
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
CLEAN=false
if [ -n "$COMMIT" ] && git -C "$REPO" diff --quiet HEAD -- infra/aws 2>/dev/null \
  && [ -z "$(git -C "$REPO" ls-files --others --exclude-standard -- infra/aws)" ] \
  && [ -z "$(find "$REPO/infra/aws" -path '*/.terraform' -prune -o \( -name 'override.tf' -o -name 'override.tf.json' -o -name '*_override.tf' -o -name '*_override.tf.json' \) -print)" ]; then
  CLEAN=true
fi
printf '{"format":"18COSMOS/L6-6-PLAN/v1","run_id":"%s","stack":"%s","captured_at":"%s","commit":"%s","infra_aws_clean":%s}\n' "$RUN" "$STACK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT" "$CLEAN" > "$OUT/run.json"
if [ "$KEEP" -eq 1 ]; then KEPT="; the saved plan kept as stack.tfplan"; else KEPT=""; fi
echo "plan evidence for $STACK written to $OUT (exit $CODE; nothing applied$KEPT)"
